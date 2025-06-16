// Simple DRACOLoader implementation for AR.js
THREE.DRACOLoader = function ( manager ) {
    this.manager = ( manager !== undefined ) ? manager : THREE.DefaultLoadingManager;
    this.decoderPath = '';
    this.decoderConfig = {};
    this.workerLimit = 4;
    this.workerPool = [];
    this.workerNextTaskID = 1;
    this.workerSourceURL = '';
    this.defaultAttributeIDs = {
        position: 'POSITION',
        normal: 'NORMAL',
        color: 'COLOR',
        uv: 'TEX_COORD'
    };
    this.defaultAttributeTypes = {
        position: 'Float32Array',
        normal: 'Float32Array',
        color: 'Float32Array',
        uv: 'Float32Array'
    };
};

THREE.DRACOLoader.prototype = {
    constructor: THREE.DRACOLoader,

    setDecoderPath: function ( path ) {
        this.decoderPath = path;
        console.log('DRACOLoader: Decoder path set to:', path);
        return this;
    },

    setDecoderConfig: function ( config ) {
        this.decoderConfig = config;
        return this;
    },

    setWorkerLimit: function ( limit ) {
        this.workerLimit = limit;
        return this;
    },

    load: function ( url, onLoad, onProgress, onError ) {
        var scope = this;
        var loader = new THREE.FileLoader( scope.manager );
        loader.setPath( this.path );
        loader.setResponseType( 'arraybuffer' );
        
        loader.load( url, function ( buffer ) {
            scope.decodeDracoFile( buffer, onLoad, onError );
        }, onProgress, onError );
    },

    decodeDracoFile: function ( buffer, callback, onError ) {
        var scope = this;
        
        console.log('DRACOLoader: Decoding Draco data, size:', buffer.byteLength);
        
        // Try different decoder paths
        var decoderPaths = [
            this.decoderPath,
            'https://www.gstatic.com/draco/v1/decoders/',
            'https://cdn.jsdelivr.net/npm/three@0.132.2/examples/js/libs/draco/gltf/'
        ];
        
        this.tryDecodePaths( buffer, decoderPaths, 0, callback, onError );
    },

    tryDecodePaths: function ( buffer, paths, pathIndex, callback, onError ) {
        var scope = this;
        
        if ( pathIndex >= paths.length ) {
            console.error('DRACOLoader: All decoder paths failed');
            if ( onError ) onError( new Error('All Draco decoder paths failed') );
            return;
        }
        
        var currentPath = paths[pathIndex];
        console.log('DRACOLoader: Trying decoder path:', currentPath);
        
        // Try to load and use decoder
        this.loadDecoderModule( currentPath, function( dracoModule ) {
            scope.decodeWithModule( buffer, dracoModule, callback, function( error ) {
                console.warn('DRACOLoader: Decoder failed with path:', currentPath, error);
                scope.tryDecodePaths( buffer, paths, pathIndex + 1, callback, onError );
            });
        }, function( error ) {
            console.warn('DRACOLoader: Failed to load decoder from:', currentPath, error);
            scope.tryDecodePaths( buffer, paths, pathIndex + 1, callback, onError );
        });
    },

    loadDecoderModule: function ( decoderPath, onLoad, onError ) {
        var scope = this;
        
        // Check if we already have Draco decoder loaded globally
        if ( typeof DracoDecoderModule !== 'undefined' ) {
            console.log('DRACOLoader: Using existing global DracoDecoderModule');
            onLoad( DracoDecoderModule );
            return;
        }
        
        // Try to load Draco decoder script
        var script = document.createElement('script');
        script.type = 'text/javascript';
        script.async = true;
        
        script.onload = function() {
            console.log('DRACOLoader: Decoder script loaded from:', decoderPath);
            
            // Wait for DracoDecoderModule to be available
            var checkModule = function() {
                if ( typeof DracoDecoderModule !== 'undefined' ) {
                    DracoDecoderModule().then( function( module ) {
                        console.log('DRACOLoader: Decoder module initialized');
                        onLoad( module );
                    }).catch( onError );
                } else {
                    setTimeout( checkModule, 50 );
                }
            };
            
            checkModule();
        };
        
        script.onerror = function() {
            console.error('DRACOLoader: Failed to load decoder script from:', decoderPath);
            onError( new Error('Failed to load Draco decoder script') );
        };
        
        // Try different script URLs
        var scriptUrls = [
            decoderPath + 'draco_decoder.js',
            decoderPath + 'draco_wasm_wrapper.js',
            decoderPath + 'draco_decoder_gltf.js'
        ];
        
        script.src = scriptUrls[0];
        document.head.appendChild( script );
    },

    decodeWithModule: function ( buffer, dracoModule, callback, onError ) {
        var scope = this;
        
        try {
            console.log('DRACOLoader: Starting decode with module');
            
            var decoder = new dracoModule.Decoder();
            var decoderBuffer = new dracoModule.DecoderBuffer();
            
            // Copy buffer data
            var array = new Int8Array( buffer );
            decoderBuffer.Init( array, array.length );
            
            // Get geometry type
            var geometryType = decoder.GetEncodedGeometryType( decoderBuffer );
            
            var dracoGeometry;
            if ( geometryType === dracoModule.TRIANGULAR_MESH ) {
                console.log('DRACOLoader: Decoding triangular mesh');
                dracoGeometry = new dracoModule.Mesh();
                var status = decoder.DecodeBufferToMesh( decoderBuffer, dracoGeometry );
            } else if ( geometryType === dracoModule.POINT_CLOUD ) {
                console.log('DRACOLoader: Decoding point cloud');
                dracoGeometry = new dracoModule.PointCloud();
                var status = decoder.DecodeBufferToPointCloud( decoderBuffer, dracoGeometry );
            } else {
                throw new Error('Unknown Draco geometry type: ' + geometryType);
            }
            
            if ( !status || !status.ok() ) {
                throw new Error('Draco decode failed: ' + status.error_msg());
            }
            
            console.log('DRACOLoader: Draco decode successful');
            
            // Convert to Three.js geometry
            var geometry = this.convertDracoGeometry( dracoGeometry, decoder, dracoModule );
            
            // Cleanup
            dracoModule.destroy( dracoGeometry );
            dracoModule.destroy( decoderBuffer );
            dracoModule.destroy( decoder );
            
            console.log('DRACOLoader: Geometry conversion complete');
            callback( geometry );
            
        } catch ( error ) {
            console.error('DRACOLoader: Decode error:', error);
            if ( onError ) onError( error );
        }
    },

    convertDracoGeometry: function ( dracoGeometry, decoder, dracoModule ) {
        var geometry = new THREE.BufferGeometry();
        
        var numPoints = dracoGeometry.num_points();
        var numFaces = dracoGeometry.num_faces();
        
        console.log('DRACOLoader: Converting geometry with', numPoints, 'points and', numFaces, 'faces');
        
        // Get attributes
        var attributeMap = {};
        var numAttributes = dracoGeometry.num_attributes();
        
        for ( var i = 0; i < numAttributes; i++ ) {
            var attribute = decoder.GetAttribute( dracoGeometry, i );
            var attributeId = attribute.attribute_type();
            
            var attributeName = 'unknown';
            switch ( attributeId ) {
                case dracoModule.POSITION:
                    attributeName = 'position';
                    break;
                case dracoModule.NORMAL:
                    attributeName = 'normal';
                    break;
                case dracoModule.TEX_COORD:
                    attributeName = 'uv';
                    break;
                case dracoModule.COLOR:
                    attributeName = 'color';
                    break;
            }
            
            console.log('DRACOLoader: Found attribute:', attributeName, 'components:', attribute.num_components());
            
            var bufferAttribute = this.convertAttribute( attribute, decoder, dracoModule );
            if ( bufferAttribute ) {
                if ( geometry.setAttribute ) {
                    geometry.setAttribute( attributeName, bufferAttribute );
                } else {
                    geometry.addAttribute( attributeName, bufferAttribute );
                }
                attributeMap[attributeName] = bufferAttribute;
            }
        }
        
        // Get faces (indices)
        if ( numFaces > 0 ) {
            var indexArray = new (numPoints > 65535 ? Uint32Array : Uint16Array)( numFaces * 3 );
            var face = new dracoModule.DracoInt32Array();
            
            for ( var i = 0; i < numFaces; i++ ) {
                decoder.GetFaceFromMesh( dracoGeometry, i, face );
                indexArray[i * 3] = face.GetValue(0);
                indexArray[i * 3 + 1] = face.GetValue(1);
                indexArray[i * 3 + 2] = face.GetValue(2);
            }
            
            geometry.setIndex( new THREE.BufferAttribute( indexArray, 1 ) );
            dracoModule.destroy( face );
            
            console.log('DRACOLoader: Added index buffer with', indexArray.length, 'indices');
        }
        
        return geometry;
    },

    convertAttribute: function ( attribute, decoder, dracoModule ) {
        var numComponents = attribute.num_components();
        var numPoints = attribute.num_values() / numComponents;
        
        var dracoArray;
        var arrayType;
        
        switch ( attribute.data_type() ) {
            case dracoModule.DT_FLOAT32:
                dracoArray = new dracoModule.DracoFloat32Array();
                arrayType = Float32Array;
                break;
            case dracoModule.DT_INT8:
                dracoArray = new dracoModule.DracoInt8Array();
                arrayType = Int8Array;
                break;
            case dracoModule.DT_INT16:
                dracoArray = new dracoModule.DracoInt16Array();
                arrayType = Int16Array;
                break;
            case dracoModule.DT_INT32:
                dracoArray = new dracoModule.DracoInt32Array();
                arrayType = Int32Array;
                break;
            case dracoModule.DT_UINT8:
                dracoArray = new dracoModule.DracoUInt8Array();
                arrayType = Uint8Array;
                break;
            case dracoModule.DT_UINT16:
                dracoArray = new dracoModule.DracoUInt16Array();
                arrayType = Uint16Array;
                break;
            case dracoModule.DT_UINT32:
                dracoArray = new dracoModule.DracoUInt32Array();
                arrayType = Uint32Array;
                break;
            default:
                console.warn('DRACOLoader: Unknown attribute data type');
                return null;
        }
        
        decoder.GetAttributeDataArrayForAllPoints( dracoGeometry, attribute, dracoArray );
        
        var typedArray = new arrayType( numPoints * numComponents );
        for ( var i = 0; i < numPoints * numComponents; i++ ) {
            typedArray[i] = dracoArray.GetValue(i);
        }
        
        dracoModule.destroy( dracoArray );
        
        return new THREE.BufferAttribute( typedArray, numComponents );
    },

    dispose: function () {
        // Cleanup workers and resources
        for ( var i = 0; i < this.workerPool.length; i++ ) {
            this.workerPool[i].terminate();
        }
        this.workerPool.length = 0;
        return this;
    }
};