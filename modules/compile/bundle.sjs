#!/usr/bin/env apollo
/*
 * Oni Apollo 'compile/bundle' module
 *
 * Part of the Oni Apollo Standard Module Library
 * Version: 'unstable'
 * http://onilabs.com/apollo
 *
 * (c) 2013 Oni Labs, http://onilabs.com
 *
 * This file is licensed under the terms of the MIT License:
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 *
 */

/**
  @module  compile/bundle
  @summary Create SJS code bundles
  @home    sjs:compile/bundle
*/
//TODO (tjc): document

var compiler = require('./deps.js');

var fs = require('sjs:nodejs/fs');
var url = require('sjs:url');
var seq = require('sjs:sequence');
var {each, toArray, map} = seq;
var str = require('sjs:string');
var object = require('sjs:object');
var assert = require('sjs:assert');
var logging = require('sjs:logging');

function findDependencies(seeds, settings) {
  var deps = {};
  var rewrites = settings.rewrites || [];
  var strict = settings.strict !== false; // true by default
  logging.verbose("rewrites:", rewrites);

  var getId = function(id) {
    rewrites .. each {|[alias, path]|
      logging.debug("checking if #{id} startswith #{path}");
      if (id .. str.startsWith(path)) {
        logging.debug("yes!");
        return alias + id.substr(path.length);
      }
    }
    if ('://' in id) return id;
    throw new Error("No module ID found for #{path}");
    return null;
  }

  function addRequire(requireName, parent) {
    if (requireName .. str.startsWith("builtin:")) {
      // ignore
      return;
    }
    logging.verbose("Processing: " + requireName);
    var module = {
      deps: [],
      loaded: false,
    };

    var src;
    var resolved;

    if (! (requireName .. str.contains(":"))) {
      requireName = url.normalize(requireName, parent.path);
      logging.debug("-> " + requireName);
    }

    try {
      resolved = require.resolve(requireName);
    } catch (e) {
      throw new Error("Error resolving " + requireName + ":\n" + e);
    }

    if (parent) parent.deps.push(resolved.path);

    try {
      if (deps.hasOwnProperty(resolved.path)) {
        logging.debug("(already processed)");
        return;
      }
      module.path = resolved.path;
      module.id = getId(resolved.path);
      deps[module.path] = module;

      src = resolved.src(resolved.path).src;
    } catch (e) {
      throw new Error("Error loading " + resolved.path + ":\n" + e);
    }

    var calls;
    try {
      calls = compiler.compile(src);
    } catch (e) {
      throw new Error("Error compiling " + resolved.path + ":\n" + e);
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

  if (!strict) {
    addRequire = relax(addRequire);
  }

  seeds .. seq.map(p -> url.fileURL(p)) .. seq.each {|mod|
    addRequire(mod);
  }

  return deps;
}

var relax = function(fn) {
  // wraps `fn`, but turns exceptions into warnings
  return function() {
    try {
      return fn.apply(this, arguments);
    } catch(e) {
      logging.warn(e.message || String(e));
    }
  }
}

function generateBundle(deps, path, settings) {
  var strict = settings.strict !== false; // true by default
  var stringifier = require('./stringify.js');
  using (var output = fs.open(path, 'w')) {
    var {Buffer} = require('nodejs:buffer');
    var write = function(data) {
      var buf = new Buffer(data + "\n");
      fs.write(output, buf, 0, buf.length);
    };

    write("(function() {");
    write("if(typeof(__oni_rt_bundle) == 'undefined')__oni_rt_bundle={};");
    write("var o = document.location.origin, b=__oni_rt_bundle;");

    var addPath = function(path) {
      var dep = deps[path];
      var id = dep.id;
      if (!id) {
        throw new Error("No ID for #{dep.path}");
      }

      var contents = fs.readFile(dep.path .. url.toPath).toString();
      var initialSize = contents.length;
      contents = stringifier.compile(contents);
      var minifiedSize = contents.length;
      var percentage = ((minifiedSize/initialSize) * 100).toFixed(2);
      logging.info("Bundled #{id} [#{percentage}%]");

      var idExpr = JSON.stringify(id);
      if (id .. str.startsWith('/')) {
        idExpr = "o+#{idExpr}";
      }
      write("b[#{idExpr}]=#{contents};");
    }.bind(this);

    if (!strict) addPath = relax(addPath);

    deps .. object.ownKeys .. seq.sort .. each(addPath);
    write("})();");
  }
  logging.info("wrote #{path}");
}

exports.main = function(opts) {
  var rewrites = (opts.alias || []) .. map(function(alias) {
    var parts = alias.split('=');
    assert.ok(parts.length > 1, "invalid alias: #{alias}");
    var alias = parts .. seq.at(-1);
    var path = parts.slice(0, -1).join("=");
    if (!(path .. str.contains(':'))) {
      path = (require('nodejs:path').normalize(path) .. url.fileURL());
      if (alias .. str.endsWith('/')) path += "/";
    }
    return [alias, path];
  }) .. toArray;

  var commonSettings = {
    strict: !opts.skip_failed,
  };

  var deps = findDependencies(opts.sources, commonSettings .. object.merge({
    rewrites: rewrites,
  }));

  if (opts.bundle) {
    generateBundle(deps, opts.bundle, commonSettings .. object.merge({
    }));
  }

  return deps;
}

if (require.main === module) {
  var parser = require('sjs:dashdash').createParser({
    options: [
      {
        names: ['help','h'],
        help: 'Print this help',
        type: 'bool',
      },
      {
        name: 'alias',
        type: 'arrayOfString',
        help: (
          'Set the runtime URL (or server path) for an on-disk location, e.g: ' +
          '--alias=components=/static/sjs/components ' +
          '--alias=/usr/lib/nodejs/apollo/modules=http://example.org/myapp/apollo ' +
          "NOTE: The URLs used here must match the URLs used by your running application, " +
          "otherwise the bundled version will be ignored."
        ),
      },
      {
        name: 'hub',
        type: 'arrayOfString',
        help: (
          'Add a compile-time require.hub alias - only used to resolve ' +
          'files at bundle-time (see `--alias` for configuring runtime URLs). e.g.: ' +
          '--bundle=lib:=components'
        ),
      },
      {
        names: ['config', 'c'],
        type: 'string',
        helpArg: 'FILE',
        help: "Extend command line options with JSON object from FILE",
      },
      {
        name: 'dump',
        type: 'bool',
        help: "Print dpeendency info (JSON)",
      },
      {
        name: 'bundle',
        type: 'string',
        helpArg: 'FILE',
        help: "Write bundle to FILE",
      },
      {
        name: 'skip-failed',
        type: 'bool',
        help: "skip any modules that can't be resolved / loaded, instead of failing",
      },
    ]
  });

  var opts = parser.parse({argv:process.argv});

  if (opts.help) {
    process.stderr.write(parser.help());
    process.exit(0);
  }
  
  opts.sources = opts._args;

  if (opts.config) {
    opts .. object.extend(fs.readFile(opts.config).toString() .. JSON.parse());
  }

  if (!(opts.dump || opts.bundle)) {
    process.stderr.write("Error: One of --bundle or --dump options are required");
    process.exit(1);
  }

  var deps = exports.main(opts);

  if (opts.dump) {
    console.log(JSON.stringify(deps, null, '  '));
    process.exit(0);
  }
  
}
