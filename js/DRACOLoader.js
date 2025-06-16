// Fixed DRACOLoader implementation for AR.js
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
    
    // Track if decoder is ready
    this.decoderModule = null;
    this.decoderPending = false;
    this.pendingRequests = [];
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
        console.log('DRACOLoader: Starting decode process, buffer size:', buffer.byteLength);
        
        var scope = this;
        
        // If decoder is already loaded, use it
        if ( this.decoderModule ) {
            this._decodeGeometry( buffer, callback, onError );
            return;
        }
        
        // If decoder is loading, queue this request
        if ( this.decoderPending ) {
            this.pendingRequests.push({ buffer: buffer, callback: callback, onError: onError });
            return;
        }
        
        // Start loading decoder
        this.decoderPending = true;
        this.pendingRequests.push({ buffer: buffer, callback: callback, onError: onError });
        
        this._loadDecoder(function() {
            // Process all pending requests
            while ( scope.pendingRequests.length > 0 ) {
                var request = scope.pendingRequests.shift();
                scope._decodeGeometry( request.buffer, request.callback, request.onError );
            }
        }, function(error) {
            console.error('DRACOLoader: Failed to load decoder:', error);
            // Fail all pending requests
            while ( scope.pendingRequests.length > 0 ) {
                var request = scope.pendingRequests.shift();
                if ( request.onError ) request.onError( error );
            }
            scope.decoderPending = false;
        });
    },

    _loadDecoder: function ( onSuccess, onError ) {
        var scope = this;
        
        // Try loading the decoder using a more reliable approach
        var decoderPaths = [
            'https://www.gstatic.com/draco/versioned/decoders/1.5.6/',
            'https://raw.githubusercontent.com/google/draco/master/javascript/',
            'https://cdn.jsdelivr.net/npm/draco3d@1.5.6/draco_decoder.js'
        ];
        
        var currentPathIndex = 0;
        
        function tryLoadDecoder() {
            if ( currentPathIndex >= decoderPaths.length ) {
                onError( new Error('All Draco decoder paths failed') );
                return;
            }
            
            var decoderPath = decoderPaths[currentPathIndex];
            console.log('DRACOLoader: Trying to load decoder from:', decoderPath);
            
            // Special handling for different decoder sources
            if ( decoderPath.includes('cdn.jsdelivr.net') ) {
                // Direct script loading
                scope._loadScript( decoderPath, function() {
                    // Check for global DracoDecoderModule
                    if ( typeof DracoDecoderModule !== 'undefined' ) {
                        DracoDecoderModule().then(function(module) {
                            scope.decoderModule = module;
                            scope.decoderPending = false;
                            console.log('✅ DRACOLoader: Decoder loaded successfully');
                            onSuccess();
                        }).catch(function(error) {
                            console.warn('DRACOLoader: Failed to initialize decoder from', decoderPath, error);
                            currentPathIndex++;
                            tryLoadDecoder();
                        });
                    } else {
                        console.warn('DRACOLoader: DracoDecoderModule not found after loading script');
                        currentPathIndex++;
                        tryLoadDecoder();
                    }
                }, function() {
                    console.warn('DRACOLoader: Failed to load script from', decoderPath);
                    currentPathIndex++;
                    tryLoadDecoder();
                });
            } else {
                // Try loading draco_decoder.js from the path
                var scriptUrl = decoderPath + 'draco_decoder.js';
                scope._loadScript( scriptUrl, function() {
                    if ( typeof DracoDecoderModule !== 'undefined' ) {
                        DracoDecoderModule().then(function(module) {
                            scope.decoderModule = module;
                            scope.decoderPending = false;
                            console.log('✅ DRACOLoader: Decoder loaded successfully');
                            onSuccess();
                        }).catch(function(error) {
                            console.warn('DRACOLoader: Failed to initialize decoder from', scriptUrl, error);
                            currentPathIndex++;
                            tryLoadDecoder();
                        });
                    } else {
                        console.warn('DRACOLoader: DracoDecoderModule not found after loading', scriptUrl);
                        currentPathIndex++;
                        tryLoadDecoder();
                    }
                }, function() {
                    console.warn('DRACOLoader: Failed to load', scriptUrl);
                    currentPathIndex++;
                    tryLoadDecoder();
                });
            }
        }
        
        tryLoadDecoder();
    },

    _loadScript: function ( url, onLoad, onError ) {
        var script = document.createElement('script');
        script.type = 'text/javascript';
        script.async = true;
        script.src = url;
        
        script.onload = function() {
            console.log('DRACOLoader: Script loaded:', url);
            if ( onLoad ) onLoad();
        };
        
        script.onerror = function() {
            console.error('DRACOLoader: Script failed to load:', url);
            if ( onError ) onError();
        };
        
        document.head.appendChild( script );
    },

    _decodeGeometry: function ( buffer, callback, onError ) {
        if ( !this.decoderModule ) {
            if ( onError ) onError( new Error('Decoder module not available') );
            return;
        }
        
        try {
            console.log('DRACOLoader: Starting decode with available module');
            
            var draco = this.decoderModule;
            var decoder = new draco.Decoder();
            
            // Create decoder buffer
            var decoderBuffer = new draco.DecoderBuffer();
            var array = new Int8Array( buffer );
            decoderBuffer.Init( array, array.length );
            
            // Determine geometry type
            var geometryType = decoder.GetEncodedGeometryType( decoderBuffer );
            console.log('DRACOLoader: Geometry type:', geometryType);
            
            var dracoGeometry;
            var status;
            
            if ( geometryType === draco.TRIANGULAR_MESH ) {
                console.log('DRACOLoader: Decoding triangular mesh');
                dracoGeometry = new draco.Mesh();
                status = decoder.DecodeBufferToMesh( decoderBuffer, dracoGeometry );
            } else if ( geometryType === draco.POINT_CLOUD ) {
                console.log('DRACOLoader: Decoding point cloud');
                dracoGeometry = new draco.PointCloud();
                status = decoder.DecodeBufferToPointCloud( decoderBuffer, dracoGeometry );
            } else {
                throw new Error('Unknown Draco geometry type: ' + geometryType);
            }
            
            if ( !status.ok() ) {
                throw new Error('Draco decode failed: ' + status.error_msg());
            }
            
            console.log('✅ DRACOLoader: Draco decode successful');
            
            // Validate decoded geometry
            if ( !dracoGeometry ) {
                throw new Error('Decoded geometry is null');
            }
            
            var actualNumPoints = dracoGeometry.num_points();
            var actualNumFaces = dracoGeometry.num_faces ? dracoGeometry.num_faces() : 0;
            
            console.log('DRACOLoader: Decoded geometry stats - Points:', actualNumPoints, 'Faces:', actualNumFaces);
            
            if ( actualNumPoints === 0 ) {
                throw new Error('Decoded geometry has no points');
            }
            
            // Convert to Three.js geometry
            var geometry = this._convertDracoGeometry( dracoGeometry, decoder, draco );
            
            if ( !geometry ) {
                throw new Error('Failed to convert Draco geometry to Three.js geometry');
            }
            
            // Cleanup
            draco.destroy( dracoGeometry );
            draco.destroy( decoderBuffer );
            draco.destroy( decoder );
            
            console.log('✅ DRACOLoader: Geometry conversion complete');
            callback( geometry );
            
        } catch ( error ) {
            console.error('❌ DRACOLoader: Decode error:', error);
            if ( onError ) onError( error );
        }
    },

    _convertDracoGeometry: function ( dracoGeometry, decoder, draco ) {
        var geometry = new THREE.BufferGeometry();
        
        var numPoints = dracoGeometry.num_points();
        var numFaces = dracoGeometry.num_faces ? dracoGeometry.num_faces() : 0;
        
        console.log('DRACOLoader: Converting geometry with', numPoints, 'points and', numFaces, 'faces');
        
        // Get attributes
        var numAttributes = dracoGeometry.num_attributes();
        console.log('DRACOLoader: Processing', numAttributes, 'attributes');
        
        // List all available attributes first
        for ( var i = 0; i < numAttributes; i++ ) {
            var attr = decoder.GetAttribute( dracoGeometry, i );
            var attrId = attr.attribute_type();
            var attrName = 'unknown';
            
            switch ( attrId ) {
                case draco.POSITION: attrName = 'position'; break;
                case draco.NORMAL: attrName = 'normal'; break;
                case draco.TEX_COORD: attrName = 'uv'; break;
                case draco.COLOR: attrName = 'color'; break;
                default: attrName = 'attr_' + attrId; break;
            }
            
            console.log('DRACOLoader: Available attribute', i, ':', attrName, 'components:', attr.num_components(), 'type:', attr.data_type());
        }
        
        // Now process each attribute
        for ( var i = 0; i < numAttributes; i++ ) {
            var attribute = decoder.GetAttribute( dracoGeometry, i );
            var attributeId = attribute.attribute_type();
            
            var attributeName = 'unknown';
            switch ( attributeId ) {
                case draco.POSITION:
                    attributeName = 'position';
                    break;
                case draco.NORMAL:
                    attributeName = 'normal';
                    break;
                case draco.TEX_COORD:
                    attributeName = 'uv';
                    break;
                case draco.COLOR:
                    attributeName = 'color';
                    break;
                default:
                    console.log('DRACOLoader: Unknown attribute type:', attributeId);
                    continue;
            }
            
            console.log('DRACOLoader: Processing attribute:', attributeName, 'components:', attribute.num_components());
            
            var bufferAttribute = this._convertAttribute( attribute, decoder, draco, dracoGeometry, numPoints );
            if ( bufferAttribute ) {
                if ( geometry.setAttribute ) {
                    geometry.setAttribute( attributeName, bufferAttribute );
                } else {
                    geometry.addAttribute( attributeName, bufferAttribute );
                }
                console.log('DRACOLoader: Added', attributeName, 'attribute');
            }
        }
        
        // Get faces (indices) for meshes
        if ( numFaces > 0 ) {
            console.log('DRACOLoader: Processing', numFaces, 'faces');
            var indexArray = new (numPoints > 65535 ? Uint32Array : Uint16Array)( numFaces * 3 );
            var face = new draco.DracoInt32Array();
            
            for ( var i = 0; i < numFaces; i++ ) {
                decoder.GetFaceFromMesh( dracoGeometry, i, face );
                indexArray[i * 3] = face.GetValue(0);
                indexArray[i * 3 + 1] = face.GetValue(1);
                indexArray[i * 3 + 2] = face.GetValue(2);
            }
            
            geometry.setIndex( new THREE.BufferAttribute( indexArray, 1 ) );
            draco.destroy( face );
            
            console.log('DRACOLoader: Added index buffer with', indexArray.length, 'indices');
        }
        
        // Validate the geometry has valid position data
        if ( geometry.attributes.position || geometry.getAttribute('position') ) {
            var positionAttr = geometry.attributes.position || geometry.getAttribute('position');
            var hasValidPositions = false;
            
            // Check first few position values
            for ( var i = 0; i < Math.min(9, positionAttr.array.length); i++ ) {
                if ( !isNaN(positionAttr.array[i]) && isFinite(positionAttr.array[i]) ) {
                    hasValidPositions = true;
                    break;
                }
            }
            
            if ( !hasValidPositions ) {
                console.error('DRACOLoader: Position attribute contains only invalid values');
                return null;
            }
            
            console.log('DRACOLoader: Position validation passed, sample values:', 
                       Array.from(positionAttr.array.slice(0, 9)));
        } else {
            console.error('DRACOLoader: No position attribute found');
            return null;
        }
        
        return geometry;
    },

    _convertAttribute: function ( attribute, decoder, draco, dracoGeometry, numPoints ) {
        var numComponents = attribute.num_components();
        var dataType = attribute.data_type();
        
        console.log('DRACOLoader: Converting attribute with', numComponents, 'components, data type:', dataType, 'numPoints:', numPoints);
        
        var TypedArrayConstructor;
        var dracoArray;
        var getDataFunction;
        
        // Determine the correct array type and API call based on data type
        switch ( dataType ) {
            case draco.DT_FLOAT32:
                TypedArrayConstructor = Float32Array;
                dracoArray = new draco.DracoFloat32Array();
                getDataFunction = 'GetAttributeFloat32ForAllPoints';
                break;
            case draco.DT_INT8:
                TypedArrayConstructor = Int8Array;
                dracoArray = new draco.DracoInt8Array();
                getDataFunction = 'GetAttributeInt8ForAllPoints';
                break;
            case draco.DT_INT16:
                TypedArrayConstructor = Int16Array;
                dracoArray = new draco.DracoInt16Array();
                getDataFunction = 'GetAttributeInt16ForAllPoints';
                break;
            case draco.DT_INT32:
                TypedArrayConstructor = Int32Array;
                dracoArray = new draco.DracoInt32Array();
                getDataFunction = 'GetAttributeInt32ForAllPoints';
                break;
            case draco.DT_UINT8:
                TypedArrayConstructor = Uint8Array;
                dracoArray = new draco.DracoUInt8Array();
                getDataFunction = 'GetAttributeUInt8ForAllPoints';
                break;
            case draco.DT_UINT16:
                TypedArrayConstructor = Uint16Array;
                dracoArray = new draco.DracoUInt16Array();
                getDataFunction = 'GetAttributeUInt16ForAllPoints';
                break;
            case draco.DT_UINT32:
                TypedArrayConstructor = Uint32Array;
                dracoArray = new draco.DracoUInt32Array();
                getDataFunction = 'GetAttributeUInt32ForAllPoints';
                break;
            default:
                console.warn('DRACOLoader: Unknown attribute data type:', dataType);
                return null;
        }
        
        try {
            console.log('DRACOLoader: Attempting to extract data using', getDataFunction);
            
            var success = false;
            
            // Try the specific typed function first
            if ( decoder[getDataFunction] && typeof decoder[getDataFunction] === 'function' ) {
                success = decoder[getDataFunction]( dracoGeometry, attribute, dracoArray );
                console.log('DRACOLoader: Typed function result:', success);
            }
            
            // Fallback to generic function if available
            if ( !success && decoder.GetAttributeDataArrayForAllPoints ) {
                success = decoder.GetAttributeDataArrayForAllPoints( dracoGeometry, attribute, dracoArray );
                console.log('DRACOLoader: Generic function result:', success);
            }
            
            // Final fallback - try to extract manually
            if ( !success ) {
                console.log('DRACOLoader: Trying manual extraction...');
                
                // Get attribute ID for manual access
                var attributeId = attribute.unique_id();
                console.log('DRACOLoader: Attribute ID:', attributeId);
                
                // Try different extraction methods
                if ( decoder.GetAttributeFloatForAllPoints ) {
                    success = decoder.GetAttributeFloatForAllPoints( dracoGeometry, attribute, dracoArray );
                } else if ( decoder.GetAttribute ) {
                    // Manual point-by-point extraction
                    var tempArray = new draco.DracoFloat32Array();
                    var extractedData = [];
                    
                    for ( var i = 0; i < numPoints; i++ ) {
                        if ( decoder.GetAttributeDataForPoint ) {
                            decoder.GetAttributeDataForPoint( dracoGeometry, attribute, i, tempArray );
                            for ( var j = 0; j < numComponents; j++ ) {
                                extractedData.push( tempArray.GetValue(j) );
                            }
                        }
                    }
                    
                    if ( extractedData.length > 0 ) {
                        // Copy manual data to dracoArray
                        dracoArray.Resize( extractedData.length );
                        for ( var k = 0; k < extractedData.length; k++ ) {
                            dracoArray.SetValue( k, extractedData[k] );
                        }
                        success = true;
                    }
                    
                    draco.destroy( tempArray );
                }
            }
            
            if ( !success ) {
                console.error('DRACOLoader: All extraction methods failed');
                draco.destroy( dracoArray );
                return null;
            }
            
            // Get the actual size from the dracoArray
            var dracoArraySize = dracoArray.size();
            console.log('DRACOLoader: Extracted data size:', dracoArraySize, 'expected:', numPoints * numComponents);
            
            // Convert to typed array
            var typedArray = new TypedArrayConstructor( dracoArraySize );
            
            // Extract values with validation
            var validCount = 0;
            for ( var i = 0; i < dracoArraySize; i++ ) {
                var value = dracoArray.GetValue(i);
                
                // Validate the value is not NaN or undefined
                if ( typeof value === 'number' && !isNaN(value) && isFinite(value) ) {
                    typedArray[i] = value;
                    validCount++;
                } else {
                    typedArray[i] = 0; // Use 0 as fallback
                }
            }
            
            console.log('DRACOLoader: Valid values:', validCount, '/', dracoArraySize);
            
            // Cleanup
            draco.destroy( dracoArray );
            
            // Validate we got some valid data
            if ( validCount === 0 ) {
                console.error('DRACOLoader: No valid data extracted');
                return null;
            }
            
            console.log('DRACOLoader: Successfully created typed array with', typedArray.length, 'elements, sample values:', 
                       Array.from(typedArray.slice(0, Math.min(6, typedArray.length))));
            
            return new THREE.BufferAttribute( typedArray, numComponents );
            
        } catch ( error ) {
            console.error('DRACOLoader: Error converting attribute:', error);
            if ( dracoArray ) {
                draco.destroy( dracoArray );
            }
            return null;
        }
    },

    dispose: function () {
        // Cleanup workers and resources
        for ( var i = 0; i < this.workerPool.length; i++ ) {
            this.workerPool[i].terminate();
        }
        this.workerPool.length = 0;
        
        // Clear pending requests
        this.pendingRequests.length = 0;
        this.decoderModule = null;
        this.decoderPending = false;
        
        return this;
    }
};