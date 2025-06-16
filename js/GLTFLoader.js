THREE.GLTFLoader = function ( manager ) {
    this.manager = ( manager !== undefined ) ? manager : THREE.DefaultLoadingManager;
    this.path = '';
    this.dracoLoader = null;
};

THREE.GLTFLoader.prototype = {
    constructor: THREE.GLTFLoader,

    load: function ( url, onLoad, onProgress, onError ) {
        var scope = this;
        var loader = new THREE.FileLoader( this.manager );
        loader.setPath( this.path );
        loader.setResponseType( 'arraybuffer' );
        
        loader.load( url, function ( data ) {
            try {
                scope.parse( data, function( gltf ) {
                    onLoad( gltf );
                });
            } catch ( e ) {
                console.error( 'GLTFLoader parse error: ', e );
                if ( onError ) {
                    onError( e );
                }
            }
        }, onProgress, onError );
    },

    setPath: function ( value ) {
        this.path = value;
        return this;
    },

    setDRACOLoader: function ( dracoLoader ) {
        this.dracoLoader = dracoLoader;
        console.log('GLTFLoader: Draco loader set');
        return this;
    },

    parse: function ( data, onLoad ) {
        var content;
        var json;
        var binaryData;
        var textDecoder = new TextDecoder();

        console.log('GLTFLoader: Parsing GLB file, size:', data.byteLength, 'bytes');

        if ( typeof data === 'string' ) {
            content = data;
        } else {
            var magic = textDecoder.decode( new Uint8Array( data, 0, 4 ) );
            console.log('GLTFLoader: File magic:', magic);
            
            if ( magic === 'glTF' ) {
                // Binary glTF (.glb)
                var view = new DataView( data );
                var version = view.getUint32( 4, true );
                var length = view.getUint32( 8, true );
                
                console.log('GLTFLoader: GLB version:', version, 'total length:', length);
                
                var offset = 12;
                
                // Read JSON chunk
                var jsonChunkLength = view.getUint32( offset, true );
                var jsonChunkType = view.getUint32( offset + 4, true );
                offset += 8;
                
                console.log('GLTFLoader: JSON chunk length:', jsonChunkLength, 'type:', jsonChunkType.toString(16));
                
                if ( jsonChunkType === 0x4E4F534A ) { // 'JSON'
                    var contentArray = new Uint8Array( data, offset, jsonChunkLength );
                    content = textDecoder.decode( contentArray );
                    offset += jsonChunkLength;
                    
                    // Check for binary chunk
                    if ( offset < data.byteLength ) {
                        var binaryChunkLength = view.getUint32( offset, true );
                        var binaryChunkType = view.getUint32( offset + 4, true );
                        offset += 8;
                        
                        console.log('GLTFLoader: Binary chunk length:', binaryChunkLength, 'type:', binaryChunkType.toString(16));
                        
                        if ( binaryChunkType === 0x004E4942 ) { // 'BIN'
                            binaryData = data.slice( offset, offset + binaryChunkLength );
                            console.log('GLTFLoader: Binary data extracted, size:', binaryData.byteLength);
                        }
                    }
                } else {
                    throw new Error('GLTFLoader: First chunk is not JSON');
                }
            } else {
                // Text glTF (.gltf)
                content = textDecoder.decode( data );
            }
        }

        try {
            json = JSON.parse( content );
            console.log('GLTFLoader: JSON parsed successfully');
            console.log('GLTFLoader: Found', (json.meshes || []).length, 'meshes');
            console.log('GLTFLoader: Found', (json.materials || []).length, 'materials');
            console.log('GLTFLoader: Found', (json.nodes || []).length, 'nodes');
            
            // Check for Draco extension
            if (json.extensionsUsed && json.extensionsUsed.includes('KHR_draco_mesh_compression')) {
                console.log('🗜️ GLTFLoader: Draco compression detected');
                if (!this.dracoLoader) {
                    console.warn('⚠️ GLTFLoader: Draco compression detected but no DRACOLoader provided');
                }
            }
        } catch ( error ) {
            console.error('GLTFLoader: JSON parse error:', error);
            if ( onError ) onError( error );
            return;
        }

        this.parseGLTF( json, binaryData, onLoad );
    },

    parseGLTF: function ( json, binaryData, onLoad ) {
        console.log('GLTFLoader: Building scene from GLTF data');
        
        var scope = this;
        var scene = new THREE.Group();
        scene.name = 'Scene';

        // Parse materials first
        var materials = this.parseMaterials( json );
        
        // Parse meshes (this now handles Draco)
        this.parseMeshes( json, binaryData, materials, function( meshes ) {
            // Parse scene
            if ( json.scenes && json.scenes.length > 0 ) {
                var sceneDef = json.scenes[0];
                if ( sceneDef.nodes ) {
                    for ( var i = 0; i < sceneDef.nodes.length; i++ ) {
                        var node = scope.parseNode( json, sceneDef.nodes[i], meshes );
                        if ( node ) scene.add( node );
                    }
                }
            }

            // If no proper scene, add all meshes directly
            if ( scene.children.length === 0 && meshes.length > 0 ) {
                console.log('GLTFLoader: No scene nodes found, adding meshes directly');
                for ( var i = 0; i < meshes.length; i++ ) {
                    if ( meshes[i] ) scene.add( meshes[i] );
                }
            }

            var gltf = {
                scene: scene,
                scenes: [ scene ],
                animations: json.animations || [],
                cameras: [],
                asset: json.asset || {}
            };

            console.log('GLTFLoader: Scene built with', scene.children.length, 'children');
            onLoad( gltf );
        });
    },

    parseMaterials: function ( json ) {
        var materials = [];
        
        if ( json.materials ) {
            for ( var i = 0; i < json.materials.length; i++ ) {
                var materialDef = json.materials[i];
                var material = new THREE.MeshBasicMaterial();
                
                if ( materialDef.name ) material.name = materialDef.name;
                
                if ( materialDef.pbrMetallicRoughness ) {
                    var pbr = materialDef.pbrMetallicRoughness;
                    if ( pbr.baseColorFactor ) {
                        material.color.setRGB( pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2] );
                        if ( pbr.baseColorFactor[3] < 1.0 ) {
                            material.transparent = true;
                            material.opacity = pbr.baseColorFactor[3];
                        }
                    }
                }
                
                material.side = THREE.DoubleSide;
                materials[i] = material;
                
                console.log('GLTFLoader: Created material:', material.name || 'Material_' + i);
            }
        }
        
        return materials;
    },

    parseMeshes: function ( json, binaryData, materials, onComplete ) {
        var scope = this;
        var meshes = [];
        var pendingDraco = 0;
        var completedDraco = 0;
        
        if ( !json.meshes ) {
            onComplete( meshes );
            return;
        }
        
        // Check for Draco compressed meshes
        for ( var i = 0; i < json.meshes.length; i++ ) {
            var meshDef = json.meshes[i];
            for ( var j = 0; j < meshDef.primitives.length; j++ ) {
                var primitive = meshDef.primitives[j];
                if ( primitive.extensions && primitive.extensions.KHR_draco_mesh_compression ) {
                    pendingDraco++;
                }
            }
        }
        
        console.log('GLTFLoader: Found', pendingDraco, 'Draco compressed primitives');
        
        function checkComplete() {
            if ( pendingDraco === 0 || completedDraco >= pendingDraco ) {
                onComplete( meshes );
            }
        }
        
        for ( var i = 0; i < json.meshes.length; i++ ) {
            var meshDef = json.meshes[i];
            var group = new THREE.Group();
            if ( meshDef.name ) group.name = meshDef.name;
            
            for ( var j = 0; j < meshDef.primitives.length; j++ ) {
                var primitive = meshDef.primitives[j];
                
                // Check for Draco compression
                if ( primitive.extensions && primitive.extensions.KHR_draco_mesh_compression ) {
                    console.log('🗜️ GLTFLoader: Processing Draco compressed primitive');
                    
                    if ( scope.dracoLoader ) {
                        scope.parseDracoGeometry( json, primitive, binaryData, function( geometry ) {
                            if ( geometry ) {
                                var material = materials[0] || new THREE.MeshBasicMaterial({ color: 0x888888 });
                                if ( primitive.material !== undefined && materials[primitive.material] ) {
                                    material = materials[primitive.material];
                                }
                                
                                var mesh = new THREE.Mesh( geometry, material );
                                mesh.name = meshDef.name || 'Mesh_' + i + '_' + j;
                                group.add( mesh );
                                
                                console.log('GLTFLoader: Created Draco mesh:', mesh.name, 'vertices:', geometry.attributes.position.count);
                            }
                            
                            completedDraco++;
                            checkComplete();
                        });
                    } else {
                        console.error('GLTFLoader: Draco compression detected but no DRACOLoader provided');
                        completedDraco++;
                        checkComplete();
                    }
                } else {
                    // Regular (uncompressed) geometry
                    var geometry = this.parseGeometry( json, primitive, binaryData );
                    
                    var material = materials[0] || new THREE.MeshBasicMaterial({ color: 0x888888 });
                    if ( primitive.material !== undefined && materials[primitive.material] ) {
                        material = materials[primitive.material];
                    }
                    
                    var mesh = new THREE.Mesh( geometry, material );
                    mesh.name = meshDef.name || 'Mesh_' + i + '_' + j;
                    group.add( mesh );
                    
                    console.log('GLTFLoader: Created regular mesh:', mesh.name, 'vertices:', geometry.attributes.position.count);
                }
            }
            
            meshes[i] = group;
        }
        
        // If no Draco, complete immediately
        if ( pendingDraco === 0 ) {
            checkComplete();
        }
    },

    parseDracoGeometry: function ( json, primitive, binaryData, onComplete ) {
        var dracoExtension = primitive.extensions.KHR_draco_mesh_compression;
        var bufferView = json.bufferViews[dracoExtension.bufferView];
        
        var byteOffset = bufferView.byteOffset || 0;
        var byteLength = bufferView.byteLength;
        
        var dracoData = binaryData.slice( byteOffset, byteOffset + byteLength );
        
        console.log('GLTFLoader: Draco data size:', dracoData.byteLength, 'bytes');
        
        // Use DRACOLoader to decode
        var scope = this;
        this.dracoLoader.decodeDracoFile( dracoData, function( geometry ) {
            console.log('✅ GLTFLoader: Draco geometry decoded successfully');
            
            // Map Draco attributes to glTF attributes
            var dracoAttributes = dracoExtension.attributes;
            var gltfGeometry = new THREE.BufferGeometry();
            
            // Copy attributes from Draco geometry
            for ( var attributeName in geometry.attributes ) {
                var attribute = geometry.attributes[attributeName];
                
                // Map Draco attribute names to Three.js names
                var threeAttributeName = attributeName;
                if ( attributeName === 'position' ) threeAttributeName = 'position';
                else if ( attributeName === 'normal' ) threeAttributeName = 'normal';
                else if ( attributeName === 'uv' ) threeAttributeName = 'uv';
                else if ( attributeName === 'color' ) threeAttributeName = 'color';
                
                if ( gltfGeometry.setAttribute ) {
                    gltfGeometry.setAttribute( threeAttributeName, attribute );
                } else {
                    gltfGeometry.addAttribute( threeAttributeName, attribute );
                }
            }
            
            // Copy index if present
            if ( geometry.index ) {
                gltfGeometry.setIndex( geometry.index );
            }
            
            // Compute normals if not present
            if ( !gltfGeometry.attributes.normal && !gltfGeometry.getAttribute('normal') ) {
                gltfGeometry.computeVertexNormals();
                console.log('GLTFLoader: Computed vertex normals for Draco geometry');
            }
            
            onComplete( gltfGeometry );
            
        }, function( error ) {
            console.error('❌ GLTFLoader: Draco decoding failed:', error);
            
            // Fallback: create empty geometry
            var fallbackGeometry = new THREE.BufferGeometry();
            var positions = new Float32Array([
                0, 0.5, 0,
                -0.5, -0.5, 0,
                0.5, -0.5, 0
            ]);
            var positionAttribute = new THREE.BufferAttribute( positions, 3 );
            
            if ( fallbackGeometry.setAttribute ) {
                fallbackGeometry.setAttribute( 'position', positionAttribute );
            } else {
                fallbackGeometry.addAttribute( 'position', positionAttribute );
            }
            
            fallbackGeometry.computeVertexNormals();
            onComplete( fallbackGeometry );
        });
    },

    parseGeometry: function ( json, primitive, binaryData ) {
        var geometry = new THREE.BufferGeometry();
        var attributes = primitive.attributes;
        
        console.log('GLTFLoader: Parsing regular geometry with attributes:', Object.keys(attributes));
        
        // Parse position attribute
        if ( attributes.POSITION !== undefined ) {
            var positionBuffer = this.parseAccessor( json, attributes.POSITION, binaryData );
            if ( positionBuffer ) {
                if ( geometry.setAttribute ) {
                    geometry.setAttribute( 'position', positionBuffer );
                } else {
                    geometry.addAttribute( 'position', positionBuffer );
                }
                console.log('GLTFLoader: Added position attribute with', positionBuffer.count, 'vertices');
            }
        }
        
        // Parse normal attribute
        if ( attributes.NORMAL !== undefined ) {
            var normalBuffer = this.parseAccessor( json, attributes.NORMAL, binaryData );
            if ( normalBuffer ) {
                if ( geometry.setAttribute ) {
                    geometry.setAttribute( 'normal', normalBuffer );
                } else {
                    geometry.addAttribute( 'normal', normalBuffer );
                }
                console.log('GLTFLoader: Added normal attribute');
            }
        }
        
        // Parse UV attribute
        if ( attributes.TEXCOORD_0 !== undefined ) {
            var uvBuffer = this.parseAccessor( json, attributes.TEXCOORD_0, binaryData );
            if ( uvBuffer ) {
                if ( geometry.setAttribute ) {
                    geometry.setAttribute( 'uv', uvBuffer );
                } else {
                    geometry.addAttribute( 'uv', uvBuffer );
                }
                console.log('GLTFLoader: Added UV attribute');
            }
        }
        
        // Parse indices
        if ( primitive.indices !== undefined ) {
            var indexBuffer = this.parseAccessor( json, primitive.indices, binaryData );
            if ( indexBuffer ) {
                geometry.setIndex( indexBuffer );
                console.log('GLTFLoader: Added index buffer with', indexBuffer.count, 'indices');
            }
        }
        
        // Compute normals if not present
        if ( !attributes.NORMAL ) {
            geometry.computeVertexNormals();
            console.log('GLTFLoader: Computed vertex normals');
        }
        
        // Fallback: create simple geometry if nothing was loaded
        if ( !geometry.attributes.position && !geometry.getAttribute('position') ) {
            console.warn('GLTFLoader: No position data found, creating fallback geometry');
            var positions = new Float32Array([
                0, 0.5, 0,
                -0.5, -0.5, 0,
                0.5, -0.5, 0
            ]);
            var positionAttribute = new THREE.BufferAttribute( positions, 3 );
            
            if ( geometry.setAttribute ) {
                geometry.setAttribute( 'position', positionAttribute );
            } else {
                geometry.addAttribute( 'position', positionAttribute );
            }
            
            geometry.computeVertexNormals();
        }
        
        return geometry;
    },

    parseAccessor: function ( json, accessorIndex, binaryData ) {
        if ( !json.accessors || !json.accessors[accessorIndex] ) {
            console.error('GLTFLoader: Accessor', accessorIndex, 'not found');
            return null;
        }
        
        var accessor = json.accessors[accessorIndex];
        
        // Check if accessor has bufferView
        if ( accessor.bufferView === undefined ) {
            console.log('GLTFLoader: Accessor', accessorIndex, 'has no bufferView, creating empty buffer');
            var itemSize = this.getItemSize( accessor.type );
            var array = new Float32Array( accessor.count * itemSize );
            return new THREE.BufferAttribute( array, itemSize );
        }
        
        if ( !json.bufferViews || !json.bufferViews[accessor.bufferView] ) {
            console.error('GLTFLoader: BufferView', accessor.bufferView, 'not found for accessor', accessorIndex);
            return null;
        }
        
        var bufferView = json.bufferViews[accessor.bufferView];
        
        var componentType = accessor.componentType;
        var type = accessor.type;
        var count = accessor.count;
        
        console.log('GLTFLoader: Parsing accessor', accessorIndex, 'type:', type, 'count:', count, 'componentType:', componentType);
        
        // Get typed array constructor
        var TypedArray;
        switch ( componentType ) {
            case 5120: TypedArray = Int8Array; break;
            case 5121: TypedArray = Uint8Array; break;
            case 5122: TypedArray = Int16Array; break;
            case 5123: TypedArray = Uint16Array; break;
            case 5125: TypedArray = Uint32Array; break;
            case 5126: TypedArray = Float32Array; break;
            default: 
                console.warn('GLTFLoader: Unknown componentType', componentType, 'using Float32Array');
                TypedArray = Float32Array;
        }
        
        // Get item size
        var itemSize = this.getItemSize( type );
        
        var byteOffset = (accessor.byteOffset || 0) + (bufferView.byteOffset || 0);
        
        // Validate that we have binary data
        if ( !binaryData || binaryData.byteLength === 0 ) {
            console.error('GLTFLoader: No binary data available for accessor', accessorIndex);
            var array = new Float32Array( count * itemSize );
            return new THREE.BufferAttribute( array, itemSize );
        }
        
        // Validate byte offset
        if ( byteOffset + count * itemSize * TypedArray.BYTES_PER_ELEMENT > binaryData.byteLength ) {
            console.error('GLTFLoader: Data out of bounds for accessor', accessorIndex);
            var array = new Float32Array( count * itemSize );
            return new THREE.BufferAttribute( array, itemSize );
        }
        
        try {
            var array = new TypedArray( binaryData, byteOffset, count * itemSize );
            console.log('GLTFLoader: Successfully created buffer attribute with', array.length, 'elements');
            return new THREE.BufferAttribute( array, itemSize );
        } catch ( error ) {
            console.error('GLTFLoader: Error creating typed array:', error);
            var fallbackArray = new Float32Array( count * itemSize );
            return new THREE.BufferAttribute( fallbackArray, itemSize );
        }
    },

    getItemSize: function ( type ) {
        switch ( type ) {
            case 'SCALAR': return 1;
            case 'VEC2': return 2;
            case 'VEC3': return 3;
            case 'VEC4': return 4;
            case 'MAT2': return 4;
            case 'MAT3': return 9;
            case 'MAT4': return 16;
            default: 
                console.warn('GLTFLoader: Unknown accessor type', type, 'using size 1');
                return 1;
        }
    },

    parseNode: function ( json, nodeIndex, meshes ) {
        if ( !json.nodes || !json.nodes[nodeIndex] ) return null;
        
        var nodeDef = json.nodes[nodeIndex];
        var node = new THREE.Object3D();
        
        if ( nodeDef.name ) node.name = nodeDef.name;
        
        // Apply transformations
        if ( nodeDef.translation ) {
            node.position.fromArray( nodeDef.translation );
        }
        if ( nodeDef.rotation ) {
            node.quaternion.fromArray( nodeDef.rotation );
        }
        if ( nodeDef.scale ) {
            node.scale.fromArray( nodeDef.scale );
        }
        if ( nodeDef.matrix ) {
            var matrix = new THREE.Matrix4();
            matrix.fromArray( nodeDef.matrix );
            node.applyMatrix4( matrix );
        }
        
        // Add mesh if present
        if ( nodeDef.mesh !== undefined && meshes[nodeDef.mesh] ) {
            node.add( meshes[nodeDef.mesh] );
        }
        
        // Add children
        if ( nodeDef.children ) {
            for ( var i = 0; i < nodeDef.children.length; i++ ) {
                var child = this.parseNode( json, nodeDef.children[i], meshes );
                if ( child ) node.add( child );
            }
        }
        
        return node;
    }
};