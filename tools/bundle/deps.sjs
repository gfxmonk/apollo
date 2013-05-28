#!/usr/bin/env apollo
var compiler = require('./c1deps.js');
var fs = require('sjs:nodejs/fs');
var url = require('sjs:url');
var seq = require('sjs:sequence');
var str = require('sjs:string');
var logging = require('sjs:logging');

console.log(process.argv);

var deps = {};
function addRequire(requireName, parent) {
	if (requireName .. str.startsWith("builtin:")) {
		// ignore
		return;
	}
	console.log("Processing: " + requireName);
	var module = {
		deps: [],
		loaded: false,
	};

	var src;
	var resolved;

	if (! (requireName .. str.contains(":"))) {
		requireName = url.normalize(requireName, parent.path);
		console.log("-> " + requireName);
	}

	try {
		resolved = require.resolve(requireName);
		//console.log(resolved);
	} catch (e) {
		logging.warn("Error resolving " + requireName + ":\n" + e);
		return;
	}

	if (parent) parent.deps.push(resolved.path);

	try {
		if (deps.hasOwnProperty(resolved.path)) {
			console.log("(already processed)");
			return;
		}
		module.path = resolved.path;
		deps[module.path] = module;

		src = resolved.src(resolved.path).src;
		//console.log(src);
	} catch (e) {
		logging.warn("Error loading " + resolved.path + ":\n" + e);
		return;
	}

	var calls;
	try {
		calls = compiler.compile(src);
		//console.log(JSON.stringify(result));
	} catch (e) {
		logging.warn("Error compiling " + resolved.path + ":\n" + e);
		return;
	}
	module.loaded = true;

	calls .. seq.each {|[name, args]|
		switch(name) {
			case "require":
				addRequire(args[0], module);
				break;
			default:
				console.log("TODO: " + name);
				break;
		}
	}
}

process.argv.slice(1) .. seq.map(p -> url.fileURL(p)) .. seq.each {|mod|
	addRequire(mod);
}


console.log("---- deps -----");
console.log(deps);
