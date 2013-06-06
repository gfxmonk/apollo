var {test, context, assert} = require('sjs:test/suite');

test("basic") {||
	var compiled = require('sjs:compile/minify').compile("
		// comment
		while(true) {
			waitfor {
				x();
			} and {
				y(); // comment 2
			}
		}");
	assert.eq(compiled, 'while(true){waitfor{x()}and{y()}}');
}
