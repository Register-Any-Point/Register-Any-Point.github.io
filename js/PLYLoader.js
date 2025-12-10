import {
	BufferGeometry,
	FileLoader,
	Float32BufferAttribute,
	Int32BufferAttribute,
	Loader,
	Points,
	PointsMaterial
} from 'three';

class PLYLoader extends Loader {

	constructor( manager ) {

		super( manager );

		this.propertyNameMapping = {};

	}

	load( url, onLoad, onProgress, onError ) {

		const scope = this;

		const loader = new FileLoader( scope.manager );
		loader.setPath( scope.path );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( scope.requestHeader );
		loader.setWithCredentials( scope.withCredentials );
		loader.load( url, function ( data ) {

			try {

				onLoad( scope.parse( data ) );

			} catch ( e ) {

				if ( onError ) {

					onError( e );

				} else {

					console.error( e );

				}

				scope.manager.itemError( url );

			}

		}, onProgress, onError );

	}

	parse( data ) {

		function parseHeader( text ) {

			const header = {
				format: null,
				vertexCount: 0,
				properties: [],
				headerLength: 0
			};

			const lines = text.split( '\n' );
			let lineIndex = 0;

			// Check PLY format
			if ( lines[ lineIndex ] !== 'ply' ) {

				throw new Error( 'Not a valid PLY file' );

			}

			lineIndex ++;

			// Parse format
			const formatMatch = lines[ lineIndex ].match( /^format\s+(\S+)\s+(\S+)/ );
			if ( formatMatch ) {

				header.format = formatMatch[ 1 ];
				header.version = formatMatch[ 2 ];
				lineIndex ++;

			}

			// Parse properties
			while ( lineIndex < lines.length ) {

				const line = lines[ lineIndex ].trim();

				if ( line === 'end_header' ) {

					header.headerLength = text.indexOf( 'end_header' ) + 'end_header'.length + 1;
					break;

				}

				const vertexMatch = line.match( /^element\s+vertex\s+(\d+)/ );
				if ( vertexMatch ) {

					header.vertexCount = parseInt( vertexMatch[ 1 ], 10 );

				}

				const propertyMatch = line.match( /^property\s+(\S+)\s+(\S+)/ );
				if ( propertyMatch ) {

					header.properties.push( {
						type: propertyMatch[ 1 ],
						name: propertyMatch[ 2 ]
					} );

				}

				lineIndex ++;

			}

			return header;

		}

		const textData = new TextDecoder().decode( data );
		const header = parseHeader( textData );

		const position = [];
		const color = [];
		const label = [];

		// Find property indices
		const xIndex = header.properties.findIndex( p => p.name === 'x' );
		const yIndex = header.properties.findIndex( p => p.name === 'y' );
		const zIndex = header.properties.findIndex( p => p.name === 'z' );
		const redIndex = header.properties.findIndex( p => p.name === 'red' );
		const greenIndex = header.properties.findIndex( p => p.name === 'green' );
		const blueIndex = header.properties.findIndex( p => p.name === 'blue' );
		const labelIndex = header.properties.findIndex( p => p.name === 'label' );

		if ( xIndex === - 1 || yIndex === - 1 || zIndex === - 1 ) {

			throw new Error( 'PLY file must contain x, y, z properties' );

		}

		// Calculate property offsets for binary format
		let propertyOffsets = {};
		let rowSize = 0;
		if ( header.format !== 'ascii' ) {

			header.properties.forEach( ( prop, idx ) => {

				let size = 0;
				if ( prop.type === 'char' || prop.type === 'uchar' ) size = 1;
				else if ( prop.type === 'short' || prop.type === 'ushort' ) size = 2;
				else if ( prop.type === 'int' || prop.type === 'uint' || prop.type === 'float' ) size = 4;
				else if ( prop.type === 'double' ) size = 8;

				propertyOffsets[ prop.name ] = rowSize;
				rowSize += size;

			} );

		}

		// Parse data
		if ( header.format === 'ascii' ) {

			const dataLines = textData.slice( header.headerLength ).split( '\n' );

			for ( let i = 0; i < header.vertexCount && i < dataLines.length; i ++ ) {

				const line = dataLines[ i ].trim();
				if ( ! line ) continue;

				const values = line.split( /\s+/ );

				position.push( parseFloat( values[ xIndex ] ) );
				position.push( parseFloat( values[ yIndex ] ) );
				position.push( parseFloat( values[ zIndex ] ) );

				if ( redIndex !== - 1 && greenIndex !== - 1 && blueIndex !== - 1 ) {

					color.push( parseFloat( values[ redIndex ] ) / 255.0 );
					color.push( parseFloat( values[ greenIndex ] ) / 255.0 );
					color.push( parseFloat( values[ blueIndex ] ) / 255.0 );

				}

				if ( labelIndex !== - 1 ) {

					label.push( parseInt( values[ labelIndex ] ) );

				}

			}

		} else {

			// Binary format
			const isLittleEndian = header.format === 'binary_little_endian';
			const dataView = new DataView( data, header.headerLength );

			for ( let i = 0; i < header.vertexCount; i ++ ) {

				const rowOffset = i * rowSize;

				// Read position
				const xProp = header.properties[ xIndex ];
				const yProp = header.properties[ yIndex ];
				const zProp = header.properties[ zIndex ];

				let x, y, z;

				if ( xProp.type === 'double' ) {

					x = dataView.getFloat64( rowOffset + propertyOffsets.x, isLittleEndian );
					y = dataView.getFloat64( rowOffset + propertyOffsets.y, isLittleEndian );
					z = dataView.getFloat64( rowOffset + propertyOffsets.z, isLittleEndian );

				} else {

					x = dataView.getFloat32( rowOffset + propertyOffsets.x, isLittleEndian );
					y = dataView.getFloat32( rowOffset + propertyOffsets.y, isLittleEndian );
					z = dataView.getFloat32( rowOffset + propertyOffsets.z, isLittleEndian );

				}

				position.push( x, y, z );

				// Read color if available
				if ( redIndex !== - 1 && greenIndex !== - 1 && blueIndex !== - 1 ) {

					const r = dataView.getUint8( rowOffset + propertyOffsets.red );
					const g = dataView.getUint8( rowOffset + propertyOffsets.green );
					const b = dataView.getUint8( rowOffset + propertyOffsets.blue );

					color.push( r / 255.0, g / 255.0, b / 255.0 );

				}

				// Read label if available
				if ( labelIndex !== - 1 ) {

					const labelProp = header.properties[ labelIndex ];
					let lbl;

					if ( labelProp.type === 'int' || labelProp.type === 'uint' ) {

						lbl = isLittleEndian ?
							dataView.getInt32( rowOffset + propertyOffsets.label, true ) :
							dataView.getInt32( rowOffset + propertyOffsets.label, false );

					} else if ( labelProp.type === 'short' || labelProp.type === 'ushort' ) {

						lbl = isLittleEndian ?
							dataView.getInt16( rowOffset + propertyOffsets.label, true ) :
							dataView.getInt16( rowOffset + propertyOffsets.label, false );

					} else {

						lbl = dataView.getUint8( rowOffset + propertyOffsets.label );

					}

					label.push( lbl );

				}

			}

		}

		// Build geometry
		const geometry = new BufferGeometry();

		if ( position.length > 0 ) geometry.setAttribute( 'position', new Float32BufferAttribute( position, 3 ) );
		if ( color.length > 0 ) geometry.setAttribute( 'color', new Float32BufferAttribute( color, 3 ) );
		if ( label.length > 0 ) geometry.setAttribute( 'label', new Int32BufferAttribute( label, 1 ) );

		geometry.computeBoundingSphere();

		// Build material
		const material = new PointsMaterial( { size: 0.005 } );

		if ( color.length > 0 ) {

			material.vertexColors = true;

		}

		// Build point cloud
		return new Points( geometry, material );

	}

}

export { PLYLoader };
