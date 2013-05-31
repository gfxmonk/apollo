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

var shouldExcude = function(path, bases) {
  return bases .. seq.any(function(ex) {
    if (path .. str.startsWith(ex)) {
      logging.verbose("Excluding: #{path}");
      return true;
    }
    return false;
  });
}

function findDependencies(sources, settings) {
  var deps = {};
  var aliases = settings.aliases || [];
  var hubs = settings.hubs || [];
  var excludes = (settings.ignore || []).concat(['builtin:']);
  var strict = settings.strict !== false; // true by default
  logging.verbose("aliases:", aliases);

  var getId = function(id) {
    aliases .. each {|[alias, path]|
      logging.debug("checking if #{id} startswith #{path}");
      if (id .. str.startsWith(path)) {
        return alias + id.substr(path.length);
      }
    }
    if (!(id .. str.startsWith('file://'))) return id;
    throw new Error("No module ID found for #{id} (missing an alias?)");
  }

  var resolveHubs = function(requireName, depth) {
    if (depth === undefined) depth = 0;
    if (depth > 10) throw new Error("Too much hub indirection");
    hubs .. each {|[alias, path]|
      logging.debug("checking if #{requireName} startswith #{alias}");
      if (requireName .. str.startsWith(alias)) {
        var resolved = path + (requireName.substr(alias.length));
        logging.verbose("resolved #{requireName} -> #{resolved}");
        return resolveHubs(resolved, depth+1);
      }
    }
    return requireName;
  }


  function addRequire(requireName, parent) {
    if (shouldExcude(requireName, excludes)) return;

    logging.verbose("Processing: " + requireName);
    var module = {
      deps: [],
      loaded: false,
    };

    var src;
    var resolved;

    // resolve relative require names & configured hubs
    requireName = resolveHubs(requireName);
    if (! (requireName .. str.contains(":"))) {
      requireName = url.normalize(requireName, parent.path);
      logging.debug("normalized to " + requireName);
    }
    if (shouldExcude(requireName, excludes)) return;


    // resolve with builtin hubs
    try {
      resolved = require.resolve(requireName);
      logging.verbose("Resolved: ", resolved);
    } catch (e) {
      throw new Error("Error resolving " + requireName + ":\n" + e);
    }

    if (shouldExcude(requireName, excludes)) return;
    if (parent && parent.deps) parent.deps.push(resolved.path);

    if (deps.hasOwnProperty(resolved.path)) {
      logging.debug("(already processed)");
      return;
    }
    module.path = resolved.path;
    module.id = getId(resolved.path);
    deps[module.path] = module;

    try {
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
      }
    }
  }

  if (!strict) {
    addRequire = relax(addRequire);
  }

  var root = {
    path: url.fileURL(process.cwd()) + "/",
  };
  logging.debug("ROOT:", root);
  sources .. each {|mod|
    addRequire(mod, root);
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
  var stringifier = require('./stringify.js');

  var strict = settings.strict !== false; // true by default
  var excludes = (settings.exclude || []);

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
      if (shouldExcude(path, excludes)) return;
      var dep = deps[path];
      var id = dep.id;
      if (!id) {
        throw new Error("No ID for #{dep.path}");
      }

      var resolved = require.resolve(dep.path);
      var contents = resolved.src(dep.path).src;

      var initialSize = contents.length;
      logging.verbose("Compiling: #{dep.path}");
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
  var expandPath = function(path) {
    if (!(path .. str.contains(':'))) {
      logging.debug("normalizing path: #{path}");
      path = url.fileURL(path);
      logging.debug("-> #{path}");
    }
    return path;
  }

  var aliases = (opts.alias || []) .. map(function(spec) {
    var [path, alias] = spec .. str.rsplit('=');
    assert.ok(alias, "invalid alias: #{spec}");
    return [alias, expandPath(path)];
  }) .. toArray;

  var hubs = (opts.hub || []) .. map(function(spec) {
    var [prefix, path] = spec .. str.split('=');
    assert.ok(path, "invalid hub: #{spec}");
    return [prefix, expandPath(path)];
  }) .. toArray;

  var ignore = (opts.ignore || []) .. map(expandPath) .. toArray;
  var exclude = (opts.exclude || []) .. map(expandPath) .. toArray;

  var commonSettings = {
    strict: !opts.skip_failed,
  };

  var deps = findDependencies(opts.sources, commonSettings .. object.merge({
    aliases: aliases,
    hubs: hubs,
    ignore: ignore,
  }));

  if (opts.bundle) {
    generateBundle(deps, opts.bundle, commonSettings .. object.merge({
      exclude: exclude,
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
        names: ['verbose','v'],
        help: 'Increase log level',
        type: 'arrayOfBool',
      },
      {
        name: 'alias',
        type: 'arrayOfString',
        help: (
          'Set the runtime URL (or server path) for an on-disk location, e.g: ' +
          '--alias=components=/static/sjs/components ' +
          '--alias=/lib/nodejs/apollo=http://example.org/apollo ' +
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
      {
        name: 'ignore',
        type: 'arrayOfString',
        helpArg : 'BASE',
        help: "ignore all modules under BASE",
      },
      {
        name: 'exclude',
        type: 'arrayOfString',
        helpArg : 'BASE',
        help: "exclude modules under BASE from bundle output (they are still parsed for dependencies, but omitted from the bundle. Use --ignore to skip modules entirely)",
      },
    ]
  });

  var opts = parser.parse({argv:process.argv});

  if (opts.help) {
    process.stderr.write(parser.help());
    process.exit(0);
  }

  if (opts.verbose) {
    logging.setLevel(logging.getLevel() + (opts.verbose.length * 10));
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
