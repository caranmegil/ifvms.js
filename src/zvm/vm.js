/*

The Z-Machine VM for versions 5 and 8
=====================================

Copyright (c) 2011 The ifvms.js team
BSD licenced
http://github.com/curiousdannii/ifvms.js

*/

/*

This file represents the public API of the ZVM class, while runtime.js contains most other class functions
	
TODO:
	Is 'use strict' needed for JIT functions too, or do they inherit that status?
	Move the header setting stuff to a separate function and call it when restoring
	
*/

// The VM itself!
/* DEBUG */
var ZVM_core = {
/* ENDDEBUG */
	
	init: function()
	{
		// Create this here so that it won't be cleared on restart
		this.jit = {};
		this.env = {
			width: 80 // Default width of 80 characters
		};
	},
	
	// An input event, or some other event from the runner
	inputEvent: function( data )
	{
		var memory = this.m,
		response;
		
		// Clear the list of orders
		this.orders = [];
		
		// Update environment variables
		if ( data.env )
		{
			extend( this.env, data.env );
		}
		
		// Load the story file
		if ( data.code == 'load' )
		{
			this.data = data.data;
			return;
		}
		
		if ( data.code == 'restart' )
		{
			this.restart();
		}
		
		if ( data.code == 'restore' )
		{
			if ( data.data )
			{
				this.restore( data.data );
			}
			else
			{
				this.variable( data.storer, 0 );
			}
		}
		
		// Handle line input
		if ( data.code == 'read' )
		{
			// Store the terminating character
			this.variable( data.storer, data.terminator );
			
			// Echo the response (7.1.1.1)
			response = data.response;
			this.print( response + '\n' );
			
			// Convert the response to lower case and then to ZSCII
			response = this.text.text_to_zscii( response.toLowerCase() );
			
			// Check if the response is too long, and then set its length
			if ( response.length > data.len )
			{
				response = response.slice( 0, data.len );
			}
			memory.setUint8( data.buffer + 1, response.length );
			
			// Store the response in the buffer
			memory.setBuffer( data.buffer + 2, response );
			
			if ( data.parse )
			{
				// Tokenise the response
				this.text.tokenise( data.buffer, data.parse );
			}
		}
		
		// Handle character input
		if ( data.code == 'char' )
		{
			this.variable( data.storer, this.text.keyinput( data.response ) );
		}
		
		// Resume normal operation
		this.run();
	},
	
	// (Re)start the VM
	restart: function()
	{
		// Set up the memory
		var memory = ByteArray( this.data ),
		
		version = memory.getUint8( 0x00 ),
		property_defaults = memory.getUint16( 0x0A ),
		extension = memory.getUint16( 0x36 );
		
		// Check if the version is supported
		if ( version != 5 && version != 8 )
		{
			throw new Error( 'Unsupported Z-Machine version: ' + version );
		}
		
		// Preserve flags 2 - the fixed pitch bit is surely the lamest part of the Z-Machine spec!
		if ( this.m )
		{
			memory.setUint8( 0x11, this.m.getUint8( 0x11 ) );
		}
		
		extend( this, {
			
			// Memory, locals and stacks of various kinds
			m: memory,
			s: [],
			l: [],
			call_stack: [],
			undo: [],
			
			// IO stuff
			orders: [],
			
			// Get some header variables
			version: version,
			pc: memory.getUint16( 0x06 ),
			properties: property_defaults,
			objects: property_defaults + 112, // 126-14 - if we take this now then we won't need to always decrement the object number
			globals: memory.getUint16( 0x0C ),
			staticmem: memory.getUint16( 0x0E ),
			extension: extension,
			extension_count: extension ? memory.getUint16( extension ) : 0,
			
			// Routine and string packing multiplier
			packing_multipler: version == 5 ? 4 : 8
			
		});
		// These classes rely too much on the above, so add them after
		extend( this, {
			ui: new UI( this ),
			text: new Text( this )
		});
		
		// Update the header
		this.update_header();
	},
	
	// Update the header after restarting or restoring
	update_header: function()
	{
		var memory = this.m;
		
		// Reset the random state
		this.random_state = 0;
		
		// Flags 1: Set bits 0, 2, 3, 4: typographic styles are OK
		// Set bit 7 only if timed input is supported
		memory.setUint8( 0x01, 0x1D | ( this.env.timed ? 0x80 : 0 ) );
		// Flags 2: Clear bits 3, 5, 7: no character graphics, mouse or sound effects
		// This is really a word, but we only care about the lower byte
		memory.setUint8( 0x11, memory.getUint8( 0x11 ) & 0x57 );
		// Screen settings
		memory.setUint8( 0x20, 255 ); // Infinite height
		memory.setUint8( 0x21, this.env.width );
		memory.setUint16( 0x22, this.env.width );
		memory.setUint16( 0x24, 255 );
		memory.setUint16( 0x26, 0x0101 ); // Font height/width in "units"
		// Z Machine Spec revision
		// For now only set 1.2 if PARCHMENT_SECURITY_OVERRIDE is set, still need to finish 1.1 support!
		memory.setUint8( 0x32, 1 );
		memory.setUint8( 0x33, this.env.PARCHMENT_SECURITY_OVERRIDE ? 2 : 0 );
		// Clear flags three, we don't support any of that stuff
		this.extension_table( 4, 0 );
	},
	
	// Run
	run: function()
	{
		var now = Date.now(),
		pc;
		
		// Stop when ordered to
		this.stop = 0;
		while ( !this.stop )
		{
			pc = this.pc;
			if ( !this.jit[pc] )
			{
				this.compile();
			}
			this.jit[pc]( this );
			
			// Or if more than five seconds has passed
			// What's the best time for this?
			// Or maybe count iterations instead?
			if ( (Date.now() - now) > 5000 )
			{
				this.act( 'tick' );
				return;
			}
		}
	},
	
	// Compile a JIT routine
	compile: function()
	{
		var context = disassemble( this ),
		code = context.write();
		
		// Compile the routine with new Function()
		/* DEBUG */
			console.log( code );
			var func = eval( '(function(e){' + code + '})' );
			
			// Extra stuff for debugging
			func.context = context;
			func.code = code;
			if ( context.name )
			{
				func.name = context.name;
			}
			this.jit[context.pc] = func;
		/* ELSEDEBUG
			this.jit[context.pc] = new Function( 'e', code );
		/* ENDDEBUG */
		if ( context.pc < this.staticmem )
		{
			console.warn( 'Caching a JIT function in dynamic memory: ' + context.pc );
		}
	},
	
	// Return control to the ZVM runner to perform some action
	act: function( code, options )
	{
		var options = options || {};
		
		// Flush the buffer
		this.ui.flush();
		
		// Flush the status if we need to
		// Should instead it be the first order? Might be better for screen readers etc
		if ( this.ui.status.length )
		{
			this.orders.push({
				code: 'stream',
				to: 'status',
				data: this.ui.status
			});
			this.ui.status = [];
		}
		
		options.code = code;
		this.orders.push( options );
		this.stop = 1;
		this.outputEvent( this.orders );
	}

/* DEBUG */
};
/* ELSEDEBUG
});
/* ENDDEBUG */