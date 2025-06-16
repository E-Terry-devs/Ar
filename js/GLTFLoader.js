THREE.GLTFLoader = function ( manager ) {
    this.manager = ( manager !== undefined ) ? manager : THREE.DefaultLoadingManager;
    this.path = '';
    this.dracoLoader = null;
    this.textureLoader = new THREE.TextureLoader( this.manager );
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
            console.log('GLTFLoader: Found', (json.textures || []).length, 'textures');
            console.log('GLTFLoader: Found', (json.images || []).length, 'images');
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

        // Parse images first with proper async handling
        this.parseImages( json, binaryData, function( images ) {
            console.log('🖼️ GLTFLoader: Images loaded, creating textures...');
            
            // Parse textures with loaded images
            var textures = scope.parseTextures( json, images );
            
            // Parse materials with texture support
            var materials = scope.parseMaterials( json, textures );
            
            // Parse meshes (this now handles Draco)
            scope.parseMeshes( json, binaryData, materials, function( meshes ) {
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
        });
    },

    parseImages: function ( json, binaryData, onComplete ) {
        var images = [];
        var scope = this;
        
        if ( !json.images || json.images.length === 0 ) {
            if ( onComplete ) onComplete( images );
            return;
        }
        
        var totalImages = json.images.length;
        var loadedImages = 0;
        
        console.log('🖼️ GLTFLoader: Loading', totalImages, 'images asynchronously...');
        
        function checkAllLoaded() {
            if ( loadedImages >= totalImages ) {
                console.log('✅ GLTFLoader: All', totalImages, 'images loaded successfully');
                if ( onComplete ) onComplete( images );
            }
        }
        
        for ( var i = 0; i < totalImages; i++ ) {
            (function( imageIndex ) {
                var imageDef = json.images[imageIndex];
                var image = new Image();
                
                // Set up load handlers
                image.onload = function() {
                    console.log('✅ GLTFLoader: Image', imageIndex, 'loaded:', 
                               imageDef.name || 'Image_' + imageIndex, 
                               'size:', this.width + 'x' + this.height);
                    loadedImages++;
                    checkAllLoaded();
                };
                
                image.onerror = function() {
                    console.error('❌ GLTFLoader: Failed to load image', imageIndex, ':', 
                                 imageDef.name || 'Image_' + imageIndex);
                    loadedImages++;
                    checkAllLoaded();
                };
                
                // Set crossOrigin before src to avoid CORS issues
                image.crossOrigin = 'anonymous';
                
                if ( imageDef.bufferView !== undefined ) {
                    // Image data is in buffer (embedded)
                    var bufferView = json.bufferViews[imageDef.bufferView];
                    var byteOffset = bufferView.byteOffset || 0;
                    var byteLength = bufferView.byteLength;
                    
                    if ( binaryData ) {
                        var imageData = binaryData.slice( byteOffset, byteOffset + byteLength );
                        var blob = new Blob( [imageData], { type: imageDef.mimeType || 'image/png' } );
                        var imageUrl = URL.createObjectURL( blob );
                        
                        image.src = imageUrl;
                        
                        console.log('🔄 GLTFLoader: Loading embedded image', imageIndex, ':', 
                                   imageDef.name || 'Image_' + imageIndex, 'size:', byteLength, 'bytes');
                        
                        // Clean up blob URL after loading
                        image.onload = (function(originalOnload, url) {
                            return function() {
                                URL.revokeObjectURL(url);
                                originalOnload.call(this);
                            };
                        })(image.onload, imageUrl);
                    } else {
                        console.error('GLTFLoader: No binary data available for embedded image');
                        loadedImages++;
                        checkAllLoaded();
                    }
                } else if ( imageDef.uri ) {
                    // External image file
                    var imagePath = scope.path + imageDef.uri;
                    image.src = imagePath;
                    
                    console.log('🔄 GLTFLoader: Loading external image', imageIndex, ':', imageDef.uri);
                } else {
                    console.error('GLTFLoader: Image has no bufferView or uri');
                    loadedImages++;
                    checkAllLoaded();
                }
                
                images[imageIndex] = image;
            })( i );
        }
    },

    parseTextures: function ( json, images ) {
        var textures = [];
        
        if ( !json.textures ) {
            return textures;
        }
        
        console.log('🎨 GLTFLoader: Creating', json.textures.length, 'textures from loaded images');
        
        for ( var i = 0; i < json.textures.length; i++ ) {
            var textureDef = json.textures[i];
            var texture = null;
            
            if ( textureDef.source !== undefined && images[textureDef.source] ) {
                var image = images[textureDef.source];
                
                // Create texture with proper settings
                texture = new THREE.Texture( image );
                
                // Essential GLTF texture settings
                texture.flipY = false; // GLTF standard
                texture.needsUpdate = true;
                texture.generateMipmaps = true;
                
                // Set encoding for color textures (assume sRGB for color textures)
                // Note: In a full implementation, you'd check the texture usage
                texture.encoding = THREE.sRGBEncoding;
                
                // Handle sampler settings
                if ( textureDef.sampler !== undefined && json.samplers ) {
                    var sampler = json.samplers[textureDef.sampler];
                    
                    // Wrap modes
                    if ( sampler.wrapS !== undefined ) {
                        switch ( sampler.wrapS ) {
                            case 33071: texture.wrapS = THREE.ClampToEdgeWrapping; break;
                            case 33648: texture.wrapS = THREE.MirroredRepeatWrapping; break;
                            case 10497: texture.wrapS = THREE.RepeatWrapping; break;
                            default: texture.wrapS = THREE.RepeatWrapping; break;
                        }
                    }
                    
                    if ( sampler.wrapT !== undefined ) {
                        switch ( sampler.wrapT ) {
                            case 33071: texture.wrapT = THREE.ClampToEdgeWrapping; break;
                            case 33648: texture.wrapT = THREE.MirroredRepeatWrapping; break;
                            case 10497: texture.wrapT = THREE.RepeatWrapping; break;
                            default: texture.wrapT = THREE.RepeatWrapping; break;
                        }
                    }
                    
                    // Filter modes
                    if ( sampler.magFilter !== undefined ) {
                        switch ( sampler.magFilter ) {
                            case 9728: texture.magFilter = THREE.NearestFilter; break;
                            case 9729: texture.magFilter = THREE.LinearFilter; break;
                            default: texture.magFilter = THREE.LinearFilter; break;
                        }
                    }
                    
                    if ( sampler.minFilter !== undefined ) {
                        switch ( sampler.minFilter ) {
                            case 9728: texture.minFilter = THREE.NearestFilter; break;
                            case 9729: texture.minFilter = THREE.LinearFilter; break;
                            case 9984: texture.minFilter = THREE.NearestMipmapNearestFilter; break;
                            case 9985: texture.minFilter = THREE.LinearMipmapNearestFilter; break;
                            case 9986: texture.minFilter = THREE.NearestMipmapLinearFilter; break;
                            case 9987: texture.minFilter = THREE.LinearMipmapLinearFilter; break;
                            default: texture.minFilter = THREE.LinearMipmapLinearFilter; break;
                        }
                    }
                }
                
                // Ensure texture updates when image finishes loading (if not already loaded)
                if ( !image.complete ) {
                    image.addEventListener('load', function() {
                        texture.needsUpdate = true;
                        console.log('🔄 GLTFLoader: Texture updated after image load completion');
                    });
                }
                
                if ( textureDef.name ) texture.name = textureDef.name;
                
                console.log('✅ GLTFLoader: Created texture', i, ':', 
                           textureDef.name || 'Texture_' + i,
                           'from image', textureDef.source,
                           'encoding:', texture.encoding,
                           'flipY:', texture.flipY);
            } else {
                console.warn('GLTFLoader: Texture', i, 'references invalid image source:', textureDef.source);
            }
            
            textures[i] = texture;
        }
        
        return textures;
    },

    parseMaterials: function ( json, textures ) {
        var materials = [];
        
        if ( !json.materials ) {
            // Create default material
            var defaultMaterial = new THREE.MeshStandardMaterial({ 
                color: 0x888888,
                roughness: 0.5,
                metalness: 0.1
            });
            defaultMaterial.name = 'DefaultMaterial';
            materials[0] = defaultMaterial;
            console.log('GLTFLoader: No materials found, created default standard material');
            return materials;
        }
        
        console.log('🎨 GLTFLoader: Processing', json.materials.length, 'materials with texture support');
        
        for ( var i = 0; i < json.materials.length; i++ ) {
            var materialDef = json.materials[i];
            
            // Use MeshStandardMaterial for better PBR support
            var material = new THREE.MeshStandardMaterial();
            
            if ( materialDef.name ) material.name = materialDef.name;
            
            // Handle PBR metallic roughness
            if ( materialDef.pbrMetallicRoughness ) {
                var pbr = materialDef.pbrMetallicRoughness;
                
                // Base color
                if ( pbr.baseColorFactor ) {
                    material.color.setRGB( pbr.baseColorFactor[0], pbr.baseColorFactor[1], pbr.baseColorFactor[2] );
                    if ( pbr.baseColorFactor[3] < 1.0 ) {
                        material.transparent = true;
                        material.opacity = pbr.baseColorFactor[3];
                    }
                }
                
                // Base color texture (diffuse map)
                if ( pbr.baseColorTexture && textures[pbr.baseColorTexture.index] ) {
                    material.map = textures[pbr.baseColorTexture.index];
                    
                    // Handle texture transform if present
                    if ( pbr.baseColorTexture.texCoord !== undefined ) {
                        // Handle alternative UV sets if needed
                        console.log('GLTFLoader: Base color texture uses texCoord', pbr.baseColorTexture.texCoord);
                    }
                    
                    console.log('✅ GLTFLoader: Applied base color texture to material:', material.name);
                }
                
                // Metallic and roughness values
                if ( pbr.metallicFactor !== undefined ) {
                    material.metalness = pbr.metallicFactor;
                }
                if ( pbr.roughnessFactor !== undefined ) {
                    material.roughness = pbr.roughnessFactor;
                }
                
                // Metallic roughness texture
                if ( pbr.metallicRoughnessTexture && textures[pbr.metallicRoughnessTexture.index] ) {
                    var mrTexture = textures[pbr.metallicRoughnessTexture.index];
                    
                    // Create separate textures for metalness and roughness
                    // In GLTF: Blue channel = metalness, Green channel = roughness
                    material.metalnessMap = mrTexture;
                    material.roughnessMap = mrTexture;
                    
                    // Set encoding for metallic/roughness (should be linear)
                    material.metalnessMap.encoding = THREE.LinearEncoding;
                    material.roughnessMap.encoding = THREE.LinearEncoding;
                    
                    console.log('✅ GLTFLoader: Applied metallic/roughness texture to material:', material.name);
                }
            }
            
            // Normal texture
            if ( materialDef.normalTexture && textures[materialDef.normalTexture.index] ) {
                material.normalMap = textures[materialDef.normalTexture.index];
                material.normalMap.encoding = THREE.LinearEncoding; // Normal maps are linear
                
                if ( materialDef.normalTexture.scale !== undefined ) {
                    material.normalScale = new THREE.Vector2( 
                        materialDef.normalTexture.scale, 
                        materialDef.normalTexture.scale 
                    );
                }
                
                console.log('✅ GLTFLoader: Applied normal texture to material:', material.name);
            }
            
            // Occlusion texture
            if ( materialDef.occlusionTexture && textures[materialDef.occlusionTexture.index] ) {
                material.aoMap = textures[materialDef.occlusionTexture.index];
                material.aoMap.encoding = THREE.LinearEncoding; // AO maps are linear
                
                if ( materialDef.occlusionTexture.strength !== undefined ) {
                    material.aoMapIntensity = materialDef.occlusionTexture.strength;
                }
                
                console.log('✅ GLTFLoader: Applied occlusion texture to material:', material.name);
            }
            
            // Emissive properties
            if ( materialDef.emissiveFactor ) {
                material.emissive.setRGB( 
                    materialDef.emissiveFactor[0], 
                    materialDef.emissiveFactor[1], 
                    materialDef.emissiveFactor[2] 
                );
            }
            
            if ( materialDef.emissiveTexture && textures[materialDef.emissiveTexture.index] ) {
                material.emissiveMap = textures[materialDef.emissiveTexture.index];
                console.log('✅ GLTFLoader: Applied emissive texture to material:', material.name);
            }
            
            // Alpha mode handling
            if ( materialDef.alphaMode ) {
                switch ( materialDef.alphaMode ) {
                    case 'BLEND':
                        material.transparent = true;
                        material.alphaTest = 0;
                        break;
                    case 'MASK':
                        material.transparent = false;
                        material.alphaTest = materialDef.alphaCutoff !== undefined ? materialDef.alphaCutoff : 0.5;
                        break;
                    case 'OPAQUE':
                    default:
                        material.transparent = false;
                        material.alphaTest = 0;
                        break;
                }
            }
            
            // Double sided
            if ( materialDef.doubleSided ) {
                material.side = THREE.DoubleSide;
            }
            
            // Force material update
            material.needsUpdate = true;
            
            materials[i] = material;
            
            var textureInfo = '';
            if ( material.map ) textureInfo += ' +diffuse';
            if ( material.normalMap ) textureInfo += ' +normal';
            if ( material.metalnessMap ) textureInfo += ' +metallic';
            if ( material.emissiveMap ) textureInfo += ' +emissive';
            if ( material.aoMap ) textureInfo += ' +ao';
            
            console.log('✅ GLTFLoader: Created material', i, ':', 
                       material.name || 'Material_' + i,
                       'textures:' + (textureInfo || ' none'),
                       'metalness:', material.metalness,
                       'roughness:', material.roughness);
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
                                var material = materials[0] || new THREE.MeshStandardMaterial({ color: 0x888888 });
                                if ( primitive.material !== undefined && materials[primitive.material] ) {
                                    material = materials[primitive.material];
                                }
                                
                                var mesh = new THREE.Mesh( geometry, material );
                                mesh.name = meshDef.name || 'Mesh_' + i + '_' + j;
                                group.add( mesh );
                                
                                console.log('GLTFLoader: Created Draco mesh:', mesh.name, 
                                           'vertices:', geometry.attributes.position.count,
                                           'material:', material.name, 
                                           'hasTexture:', !!material.map);
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
                    
                    var material = materials[0] || new THREE.MeshStandardMaterial({ color: 0x888888 });
                    if ( primitive.material !== undefined && materials[primitive.material] ) {
                        material = materials[primitive.material];
                    }
                    
                    var mesh = new THREE.Mesh( geometry, material );
                    mesh.name = meshDef.name || 'Mesh_' + i + '_' + j;
                    group.add( mesh );
                    
                    console.log('GLTFLoader: Created regular mesh:', mesh.name, 
                               'vertices:', geometry.attributes.position.count,
                               'material:', material.name, 
                               'hasTexture:', !!material.map);
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
            onComplete( geometry );
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
        
        // Parse UV attribute (TEXCOORD_0)
        if ( attributes.TEXCOORD_0 !== undefined ) {
            var uvBuffer = this.parseAccessor( json, attributes.TEXCOORD_0, binaryData );
            if ( uvBuffer ) {
                if ( geometry.setAttribute ) {
                    geometry.setAttribute( 'uv', uvBuffer );
                } else {
                    geometry.addAttribute( 'uv', uvBuffer );
                }
                console.log('GLTFLoader: Added UV attribute (TEXCOORD_0)');
            }
        }
        
        // Parse additional UV sets if present
        if ( attributes.TEXCOORD_1 !== undefined ) {
            var uv2Buffer = this.parseAccessor( json, attributes.TEXCOORD_1, binaryData );
            if ( uv2Buffer ) {
                if ( geometry.setAttribute ) {
                    geometry.setAttribute( 'uv2', uv2Buffer );
                } else {
                    geometry.addAttribute( 'uv2', uv2Buffer );
                }
                console.log('GLTFLoader: Added UV2 attribute (TEXCOORD_1)');
            }
        }
        
        // Parse color attribute if present
        if ( attributes.COLOR_0 !== undefined ) {
            var colorBuffer = this.parseAccessor( json, attributes.COLOR_0, binaryData );
            if ( colorBuffer ) {
                if ( geometry.setAttribute ) {
                    geometry.setAttribute( 'color', colorBuffer );
                } else {
                    geometry.addAttribute( 'color', colorBuffer );
                }
                console.log('GLTFLoader: Added color attribute');
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
        var byteStride = bufferView.byteStride;
        
        // Validate that we have binary data
        if ( !binaryData || binaryData.byteLength === 0 ) {
            console.error('GLTFLoader: No binary data available for accessor', accessorIndex);
            var array = new Float32Array( count * itemSize );
            return new THREE.BufferAttribute( array, itemSize );
        }
        
        try {
            var array;
            
            if ( byteStride && byteStride !== itemSize * TypedArray.BYTES_PER_ELEMENT ) {
                // Interleaved buffer - need to extract data with stride
                console.log('GLTFLoader: Handling interleaved buffer with stride', byteStride);
                array = new TypedArray( count * itemSize );
                var sourceView = new DataView( binaryData, byteOffset );
                
                for ( var i = 0; i < count; i++ ) {
                    for ( var j = 0; j < itemSize; j++ ) {
                        var offset = i * byteStride + j * TypedArray.BYTES_PER_ELEMENT;
                        array[i * itemSize + j] = this.getTypedArrayValue( sourceView, offset, componentType );
                    }
                }
            } else {
                // Direct buffer access
                array = new TypedArray( binaryData, byteOffset, count * itemSize );
            }
            
            return new THREE.BufferAttribute( array, itemSize );
        } catch ( error ) {
            console.error('GLTFLoader: Error creating typed array:', error);
            var fallbackArray = new Float32Array( count * itemSize );
            return new THREE.BufferAttribute( fallbackArray, itemSize );
        }
    },

    getTypedArrayValue: function ( dataView, offset, componentType ) {
        switch ( componentType ) {
            case 5120: return dataView.getInt8( offset );
            case 5121: return dataView.getUint8( offset );
            case 5122: return dataView.getInt16( offset, true );
            case 5123: return dataView.getUint16( offset, true );
            case 5125: return dataView.getUint32( offset, true );
            case 5126: return dataView.getFloat32( offset, true );
            default: return 0;
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