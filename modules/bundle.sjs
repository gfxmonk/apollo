#!/usr/bin/env sjs
/*
 * StratifiedJS 'bundle' module
 *
 * Part of the StratifiedJS Standard Module Library
 * Version: '0.19.0-development'
 * http://onilabs.com/stratifiedjs
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
  @module  bundle
  @summary Create SJS code bundles
  @home    sjs:bundle
  @executable
  @hostenv nodejs
  @desc
    StratifiedJS' module system encourages you to break your code into
    individual modules. This is good for code maintainability, but can
    slow the load time of an application that uses many modules if each
    module is requested serially over a HTTP connection with high latency.

    The bundle module provides a way to package up all the modules your
    application needs into a single javascript file. This reduces the
    number of requests made while loading your application, and allows the
    module sources to be downloaded in parallel with the SJS runtime itself.
    It also strips comments from source code, to reduce file size.

    **Note**: since SJS code is dynamic, it is impossible to fully determine
    which modules your application imports. The dependency resolver will
    *only* include modules that it can statically determine will *always* be
    used - this generally only covers `require("moduleName")` statements
    at the top-level of your module. For dynamically-required modules that you
    want to include in your bundle, you will need to explicitly include them
    as inputs to the bundle.

    This module can be imported from SJS code, but it can also be directly
    invoked from the command line by running e.g:

        sjs sjs:bundle --help

    Although multiple functions are exported from this module, most users
    will only need to use [::create].
    

    ### Using bundles

    To use a module bundle, add it like any other javascript file in
    your HTML header:
    
        <script src="/bundle.js"></script>

    Once the bundle has been downloaded by your browser,
    require(moduleName) will load `moduleName` from the bundle,
    rather than requesting the module file over HTTP. Normally you
    should place this file before `stratified.js`, so that the
    bundled modules will be ready by the time your inline SJS is
    executed.

    Any modules not present in the bundle will be loaded in the usual
    way over HTTP - the bundle is just a cache to speed things up.

    You can include multiple bundle files in a single HTML document,
    for example to use one bundle for your third-party dependencies
    and another bundle for just your application code. Bundles will
    add to the existing set of cached module sources.
*/

var compiler = require('./compile/deps.js');

var fs = require('sjs:nodejs/fs');
var url = require('sjs:url');
var { coerceToURL } = url;
var seq = require('sjs:sequence');
var { each, toArray, map, transform, filter, concat, sort, any } = seq;
var str = require('sjs:string');
var regexp = require('sjs:regexp');
var { split, rsplit, startsWith } = str;
var object = require('sjs:object');
var { get, hasOwn, ownKeys, ownValues, ownPropertyPairs } = object;
var docutil = require('sjs:docutil');
var assert = require('sjs:assert');
var logging = require('sjs:logging');
var { isArrayLike } = require('builtin:apollo-sys');

var stringToPrefixRe = function(s) {
  if (str.isString(s)) return new RegExp('^' + regexp.escape(s));
  else return s;
};

var wildcardToRe = function(s) {
  if (str.isString(s)) {
    var parts = s.split(/\*+/);
    return new RegExp("^#{parts .. seq.map(regexp.escape) .. seq.join('.*')}$");
  } else {
    return s;
  }
};

var matchesAnyPattern = function(path, patterns) {
  return patterns .. seq.any(function(pat) {
    if (pat.test(path)) {
      logging.verbose("Excluding: #{path}");
      return true;
    }
    return false;
  });
}

/**
  @function findDependencies
  @summary scan source modules for static dependencies
  @param {Array} [sources] Module paths (array of strings)
  @param {Settings} [settings]
  @return {Object}
  @desc
    Returns a structure suitable for passing to [::generateBundle].
    
    Most code should not need to use this function directly - see [::create].
*/
function findDependencies(sources, settings) {
  settings = sanitizeOpts(settings);
  var resources = settings.resources;
  var hubs = settings.hubs;
  var excludes = settings.ignore;
  var strict = settings.strict;
  logging.verbose("resources:", resources);

  var getId = function(id) {
    // rationalize full paths *back* into hub shorthand using only
    // explicitly-referenced hubs (and then those in aliases), assuming that all
    // such hubs will be configured on the client
    var aliases = usedHubs .. ownPropertyPairs .. concat(resources);
    var depth=0;
    aliases .. each {|[name, path]|
      logging.debug("checking if #{id} startswith #{path}");
      if (id .. str.startsWith(path)) {
        id = name + id.substr(path.length);
        logging.debug("Shortened -> #{id}");
      }
    }
    if (!(id .. str.startsWith('file://'))) return id;
    throw new Error("No module ID found for #{id} (missing a resource mapping?)");
  }

  var usedHubs = {};
  var modules = {};

  function includeAllStatements() { return true; };
  includeAllStatements.add = function() {};

  function StatementFilter() {
    var indexes = []; // sparse array of booleans
    var stmts = []; // XXX for debugging only
    var rv = function(index) {
      assert.notEq(index, undefined);
      return indexes[index] === true;
    };
    rv.add = function(stmt) {
      if(!indexes .. object.hasOwn(stmt.index)) {
        indexes[stmt.index] = true;
        stmts[stmt.index] = stmt;
      }
    };
    return rv;
  };

  // map of module_id -> ([stmts] | null)
  var requirements = {};

  function loadModule(requireName, parent, prefix) {
    if (requireName .. matchesAnyPattern(excludes)) return;

    logging.debug("Processing: " + requireName);
    var module = {
      exports: [],
      stmts: [],
      statementFilter: settings.strip ? StatementFilter() : includeAllStatements,
      loaded: false,
      required: false,
    };

    var src;
    var resolved;

    // resolve relative require names & builtin hubs
    requireName = resolveHubs(requireName, hubs, usedHubs);
    if (requireName.indexOf(':', 2) === -1) {
      requireName = url.normalize(requireName, parent.path);
      logging.debug("normalized to " + requireName);
    }
    if (requireName .. matchesAnyPattern(excludes)) return;


    // resolve with builtin hubs
    try {
      resolved = require.resolve(requireName);
    } catch (e) {
      throw new Error("Error resolving " + requireName + ":\n" + e);
    }

    if (requireName .. matchesAnyPattern(excludes)) return;

    if (modules .. object.hasOwn(resolved.path)) {
      logging.debug("(already processed)");
      module = modules[resolved.path];
      if (module.ignore) return null;
      return module;
    }
    logging.verbose("Resolved: ", resolved);
    module.path = resolved.path;
    module.id = getId(resolved.path);
    modules[module.path] = module;

    try {
      src = resolved.src(resolved.path).src;
    } catch (e) {
      throw new Error("Error loading " + resolved.path + ":\n" + e);
    }

    var metadata;
    try {
      var metadata = compiler.compile(src);
    } catch (e) {
      throw new Error("Error compiling " + resolved.path + ":\n" + e);
    }
    module.loaded = true;
    module.stmts = metadata.toplevel.stmts;
    module.requireAnnotations = [];
    module.statementFilter = new StatementFilter(module);

    metadata.toplevel.stmts .. seq.indexed .. seq.each {|[idx, stmt]|
      logging.debug(" --- Stmt: " + stmt);
      stmt.calculateDependencies(metadata.toplevel);
      logging.debug(" - scope: ", stmt.exportScope);
      ;(stmt.stmt.provides || []) .. seq.each {|ref|
        logging.debug(" - provides:" + ref);
        ;(ref.values || []) .. seq.each {|ref|
          logging.debug("   - assumes value:" + ref);
        }
      }
      stmt.dependencies .. seq.each {|ref|
        logging.debug(" - needs:" + ref);
      }

      stmt.moduleDependencies .. seq.each {|ref|
        logging.debug(" - needsMod:" + ref);
      }

      stmt.references .. seq.each {|ref|
        logging.debug(" - references:" + ref);
      }
    }

    var docs = docutil.parseModuleDocs(src);
    if(docs.hostenv === 'nodejs') {
      logging.verbose("Dropping nodejs module " + module.id);
      module.ignore = true;
      return null;
    }
    if (docs['bundle-exclude'] === 'true') {
      if(!requireName .. matchesAnyPattern(settings.include)) {
        logging.info("Skipping @bundle-exclude module #{module.id} (use --include to override)");
        module.ignore = true;
        return null;
      }
    }

    if (docs['re-exports-dependencies']) {
      module.transitive = [];
      // hash of path -> property|null
      metadata.toplevel.stmts .. seq.each {|stmt|
        ;(stmt.stmt.provides || []) .. seq.each {|provides|
          if (metadata.toplevel.is_exports(provides)) {
            logging.debug(" - provides exports:" + provides);
            provides.values .. seq.each {|val|
              var deps = metadata.toplevel.determineModuleReferences(val);
              module.transitive = module.transitive.concat(deps);
            }
          }
        }
      }
    }

    if(docs.require) {
      var trimAll = a -> a .. seq.map(s -> s.trim());
      function addRequireAnnotations(exportScope, annotations) {
        if (!annotations) return;
        logging.verbose("Adding require annotation: ", annotations);
        annotations .. seq.each {|req|
          var [name, paths] = req.split('#') .. trimAll();
          if (paths) paths = paths.split(',') .. trimAll();
          else paths = [null];

          var scopeAnnotations = module.requireAnnotations
            .. seq.find([k,v] -> k == exportScope, null);

          if (!scopeAnnotations) {
            scopeAnnotations = [exportScope, []];
            module.requireAnnotations.push(scopeAnnotations);
          }

          paths .. seq.each {|path|
            if (path !== null) {
              path = path.split(".") .. seq.map(s -> s.trim());
            }
            scopeAnnotations[1].push([name, path]);
          }
        }
      }

      addRequireAnnotations(null, docs.require);
      docs.children .. object.ownPropertyPairs .. seq.each {|[name, childDocs]|
        addRequireAnnotations(name, childDocs.require);
      }
    }
    return module;
  }

  if (!strict) {
    loadModule = relax(loadModule);
  }

  function addModuleAnnotations(mod, property) {
    mod.requireAnnotations .. seq.each { |[exportScope, annotations]|
      if (exportScope === null || exportScope === property) {
        annotations .. seq.each {| [name, path]|
          var depMod = loadModule(name, mod);
          addModule(depMod, path, mod);
        }
      }
    }
  }

  function addModule(module, path, parent) {
    if (!module) return; // this will have already printed a warning
    if (path == null) path = [];
    if (path === false) path = [false];
    if (!Array.isArray(path)) {
      throw new Error("invalid `path`: " + JSON.stringify(path));
    }
    if (!settings.strip) path = [];
    if (!parent) path = [];
    var property = path.length == 0 ? null : path[0];
    if (module.exports .. seq.hasElem(property)) {
      // already processed
      return;
    }

    if (parent) {
      logging.verbose("Adding dependency on #{module.id}##{path} from #{parent.id}");
    } else {
      logging.debug("Adding dependency on #{module.id} (toplevel)");
    }

    module.required = true;
    if (property === false) {
      // don't do anything more than including the empty module
      logging.verbose("including empty module: ", module.id);
      return;
    }

    module.exports.push(property);
    addModuleAnnotations(module, property);

    if (module.transitive && (property || !settings.strip)) {
      module.transitive .. seq.each {|dep|
        addModuleDependency(module, dep, path);
      }
    }

    if (property) {
      module.stmts .. seq.each {|stmt|
        if (stmt.exportScope .. seq.hasElem(null) || stmt.exportScope .. seq.hasElem("exports.#{property}")) {
          logging.debug("adding statement with scopes: ", stmt.exportScope);
          addStatement(module, stmt);
        }
      }
    } else {
      if (settings.strip && parent) {
        if (module == parent) {
          logging.info("Can't strip " + module.id + " (self-reference)");
        } else {
          logging.warn("Can't strip " + module.id + " due to reference in " + parent.id);
        }
      }
      module.statementFilter = includeAllStatements;
      module.stmts .. seq.each(stmt -> addStatement(module, stmt));
    }
  }

  function canonicalizeRequireArgument(arg) {
    var mods = arg;
    // turn require(a) -> require([a])
    if (!Array.isArray(mods)) {
      mods = [mods];
    }

    var rv = [];
    mods .. seq.each {|mod|
      if(!mod) continue;
      var id = mod;
      var name = null;

      if (typeof(id) !== 'string') {
        id = mod.id;
        if (!id) {
          logging.warn("require() argument without \`id\`: " + JSON.stringify(mod));
          continue;
        }
        name = mod.name || null;
      }

      rv.push({
        id: id,
        name: name,
      });
    };
    return rv;
  }

  function addModuleDependency(module, moduleDep, prefix) {
    if (moduleDep.is_self) {
      logging.verbose("module self reference");
      // if a statement references the module itself
      // (via `module` / `exports`, we have to include the
      // entire module
      addModule(module, null, module);
      return;
    }

    var path = moduleDep.path;
    if (prefix) {
      // may be set if we're coming via a transitive depencency
      path = prefix.concat(path);
    }
    var prop = path[0] || null;
    logging.verbose("Adding module dependency: " + moduleDep + " (" + path + ")");

    var args = moduleDep.arg .. canonicalizeRequireArgument();
    var providesExport = function(module, arg) {
      // first, see if we can tell from the exclude / include args:
      var exclude = arg .. get('exclude', []);
      var include = arg .. get('include', null);
      if (exclude .. seq.hasElem(prop)) return false;
      if (include && include .. seq.hasElem(prop)) return true;

      var exportName = "exports.#{prop}";
      module.stmts .. seq.each {|stmt|
        if (stmt.exportScope.indexOf(exportName) !== -1) {
          return true;
        }
      }
      return false;
    };


    var potentialDeps = [];
    var found = [];
    args .. seq.each {|arg|
      var {id, name} = arg;
      var required = false;

      var dep = loadModule(id, module, name || null);
      if (name) {
        if (prop === name) {
          // `require({id:mod, name:prop}).prop.foo`
          // is a reference to mod.foo, not mod.prop.
          // we also know for sure that no other argument
          // could be the provider of this dependency
          found.push([dep, path.slice(1)]);
          //addModule(loadModule(id, module, name), path.slice(1));
        } else {
          if (prop) {
            // we're not accessing something under this module
            potentialDeps.push([dep, false]);
          } else {
            potentialDeps.push([dep, path.slice(1)]);
          }
        }
      } else {
        // unnamed - treat as a merge import
        if (dep) {
          if (prop && providesExport(dep, arg)) {
            found.push([dep, path]);
          } else {
            potentialDeps.push([dep, path]);
          }
        }
      }
    }

    var isFound = found.length > 0;
    if (found.length > 1) {
      logging.info("Multiple modules seem to provide #{prop}");
    }
    found .. seq.each {|[dep, path]|
      if (dep) {
        logging.debug("Found provider of #{prop}: #{dep.id}");
      }
      addModule(dep, path, module);
    }

    if (!isFound && prop && potentialDeps.length > 1) {
      logging.debug("Couldn't determine which module provides #{prop}, from candidates:", args);
    }

    potentialDeps .. seq.each {|[dep, path]|
      addModule(dep, isFound ? false : path, module);
    }
  };

  var seenStatements = [];
  function addStatement(module, statement) {
    if (seenStatements.indexOf(statement) !== -1) return;
    seenStatements.push(statement);

    //logging.debug("Adding statement: " + statement);
    module.statementFilter.add(statement);

    statement.dependencies .. seq.each {|dep|
      addStatement(module, dep);
    }

    statement.moduleDependencies .. seq.each {|moduleDep|
      addModuleDependency(module, moduleDep);
    }
  }

  var root = {
    path: url.fileURL(process.cwd()) + "/",
  };
  logging.debug("ROOT:", root);
  sources .. map(function(mod) {
    logging.debug("Loading module: #{mod}");
    loadModule(mod, root);
  }) .. each(addModule);

  // filter out loaded modules that didn't end up being used
  modules .. ownKeys .. toArray() .. each {|id|
    if (!modules[id].required) {
      logging.debug("Removing unused " + id);
      delete modules[id];
    }
  }
  
  // filter out usedHubs that didn't end up with any modules under them
  usedHubs .. ownKeys .. toArray() .. each {|h|
    if (!modules .. ownValues .. any(v -> v.id && v.id .. startsWith(h))) {
      delete usedHubs[h];
    }
  }

  // remove unnecessary parts of `module` structure
  modules .. object.ownValues .. seq.each {|mod|
    var stmts = mod.stmts;
    delete mod.stmts;
    delete mod.requireAnnotations;
    delete mod.transitive;

    if (!settings.strip) continue;

    var strip = mod.strip = {};
    if (mod.statementFilter === includeAllStatements) {
      strip.included = stmts.length;
    } else {
      strip.included = stmts .. seq.filter(function(s) {
        if (mod.statementFilter(s.index)) {
          return true;
        }
      }) .. seq.count();
    }
    strip.excluded = stmts.length - strip.included;
  }

  return {
    hubs: usedHubs,
    modules: modules,
  };
}
exports.findDependencies = findDependencies;

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

/**
  @function generateBundle
  @summary generate a .js bundle file from the given module sources
  @param {Object} [deps] The result of [::findDependencies]
  @param {Settings} [settings]
  @return {sequence::Stream} Stream of Strings
  @desc
    Generates a stream of bundle file content lines.
    
    Most code should not need to use this function directly - see [::create].
*/
function generateBundle(deps, settings) {
  settings = sanitizeOpts(settings);
  var compile;
  if (settings.compile) {
    var compiler = require('./compile/sjs');
    compile = function(src, statementFilter) {
      var js = compiler.compile(src, {
        globalReturn:true,
        filename:"__onimodulename",
        statementFilter: statementFilter,
      });
      return "function(#{require.extensions['sjs'].module_args.join(',')}) {
        #{js}
      }"
    }
  } else {
    var stringifier = require('./compile/stringify');
    compile = (src, statementFilter) -> stringifier.compile(src, {
      keeplines: true,
      statementFilter: statementFilter,
    });
  }

  var strict = settings.strict;
  var excludes = settings.exclude;

  var rv = seq.Stream {|write|
    write("(function() {");
    write("if(typeof(__oni_rt_bundle) == 'undefined')__oni_rt_bundle={};");
    write("var o = document.location.origin, b=__oni_rt_bundle;");
    write("if(!b.h) b.h={};");
    write("if(!b.m) b.m={};");

    var hubNames = deps.hubs .. ownKeys .. sort();
    hubNames .. each {|name|
      logging.debug("Adding hub: #{name}");
      var nameExpr = JSON.stringify(name);
      // ensure bundle.hubs[name] is an array
      write("if(!b.h[#{nameExpr}])b.h[#{nameExpr}]=[];");
    }

    var addPath = function(path) {
      if (path .. matchesAnyPattern(excludes)) return;
      logging.debug("Adding path #{path}");
      var dep = deps.modules[path];
      var id = dep.id;
      if (!id) {
        throw new Error("No ID for #{dep.path}");
      }

      var setContents;
      var idExpr = JSON.stringify(id);
      if (id .. str.startsWith('/')) {
        idExpr = "o+#{idExpr}";
      }

      hubNames .. each {|name|
        if (id .. str.startsWith(name)) {
          // if ID starts with a known hub, add it to the appropriate hub array
          setContents = (c) -> write("b.h[#{JSON.stringify(name)}].push([#{JSON.stringify(id.substr(name.length))}, #{c}]);");
          break;
        }
      }
      if (!setContents) {
        // if ID is not hub-based, write it as an absolute module ID
        setContents = (c) -> write("b.m[#{idExpr}]=#{c};");
      }

      var resolved = require.resolve(dep.path);
      var contents = resolved.src(dep.path).src;

      var initialSize = contents.length;
      logging.verbose("Compiling: #{dep.path}");
      contents = compile(contents, dep.statementFilter);
      var minifiedSize = contents.length;
      var percentage = initialSize == 0 ? 0 : ((minifiedSize/initialSize) * 100).toFixed(2);
      logging.info("Bundled #{id} [#{minifiedSize}b, #{percentage}%]");

      setContents(contents);
    }.bind(this);

    if (!strict) addPath = relax(addPath);

    deps.modules .. object.ownKeys .. seq.sort .. each(addPath);
    write("})();");
  }
  return rv;
}
exports.generateBundle = generateBundle;

/**
  @function contents
  @summary List the modules defined in a given bundle
  @param {String|Object} [bundle] Bundle source
  @return {Array} The module URLs defined in the bundle
  @desc
    The `bundle` argument should be one of:

      - a string
      - an object with a `file` property
      - an object with a `contents` property

    In the first two cases, the contents will be loaded
    from the given file path.

    The returned URLs will be however ths bundle defines them.
    At present, bundles contain all of the following
    URL types when needed:

      - unresolved hub-based URLs, e.g "sjs:sequence.sjs"
      - path-only URLs, e.g "/lib/foo.sjs"
      - full URLs, e.g "http://example.com/lib/foo.sjs"
*/
exports.contents = function(bundle) {
  if (str.isString(bundle)) {
    bundle = { file: bundle }
  };
  var bundleContents = bundle.file ? fs.readFile(bundle.file) : bundle.contents;
  assert.ok(bundleContents, "bundle contents are empty");
  // In order to load arbitrary bundles, we emulate the browser vars
  // that the bundle code uses, then eval() that and see what modules
  // got defined
  var loader = eval("
    (function(__oni_rt_bundle, document) {
      #{bundleContents};
    })"
  );
  var bundle = {}, document = {location: { origin: '' }};
  loader(bundle, document);
  var urls = [];
  bundle.h .. ownPropertyPairs .. each {|[hub, modules]|
    modules .. each {|[path, contents]|
      urls.push(hub + path);
    }
  }
  urls = urls.concat(bundle.m .. ownKeys .. toArray);
  return urls;
};

/**
  @function create
  @summary Generate a module bundle from the given sources (including dependencies)
  @param {Settings} [settings]
  @setting {Array} [sources] Array of source module names to scan
  @setting {Object} [resources] Resource locations (a mapping of server-side path to client-side URL)
  @setting {Object} [hubs] Additional hub locations
  @setting {String} [output] File path of bundle file to write
  @setting {Bool} [compile] Precompile to JS (larger file size but quicker startup)
  @setting {Bool} [skipFailed] Skip modules that can't be resolved / loaded
  @setting {Array} [ignore] Array of ignored paths (to skip entirely)
  @setting {Array} [exclude] Array of excluded paths (will be processed, but omitted from bundle)
  @desc
    The settings provided to this function match the options given
    to this module when run from the command line.

    If `output` is given, the file will be written and the
    dependency information (as from [::findDependencies]) will be returned.

    Otherwise, the resulting bundle wil be returned as a {sequence::Stream} of
    (JavaScript) source code strings (as from [::generateBundle]).

    Run `sjs sjs:bundle --help` to see a full
    description of what these options do.

    ### Example:

        bundle.create({
          output:"bundle.js",
          resources: {
            # the current working directory (on the server) corresponds to /static/ (in a browser)
            "./": "/static/"
          },
          hubs: {
            # the dependency analyser should look for "lib:foo" under "components/foo"
            # (this is only required for hubs that are not already in `require.hubs`)
            "lib:": "components/"
          },
          sources: [
            "app/main.sjs",
            "sjs:sequence"
          ]
        });

        // wrote "bundle.js"
*/

var resolveHubs = function(path, localAliases, usedHubs) {
  // resolve up to one hub alias
  // if usedHubs is provided, its keys will be populated
  // with any aliases used
  var changed = true;
  var depth = 0;
  var aliases = require.hubs .. filter(h -> h[1] .. str.isString());
  if (localAliases) aliases = localAliases .. concat(aliases);
  while(changed) {
    if(depth++ > 10) throw new Error("Too much hub recursion");
    changed = false;
    aliases .. each {|[prefix, dest]|
      logging.debug("checking if #{path} startswith #{prefix}");
      if (path .. str.startsWith(prefix)) {
        if (usedHubs && !usedHubs .. hasOwn(prefix)) {
          usedHubs[prefix] = dest;
        }
        path = dest + path.slice(prefix.length);
        logging.verbose("resolved -> #{path}");
        changed = true;
        break;
      }
    }
  }
  return path;
};

var toPairs = function(obj, splitter, name) {
  // yields ownPropertyPairs if `obj` is an object
  // returns unmodified obj if it is already a nested array
  // calls `splitter` on each value if `obj` is an array of strings
  // (this assumes elements of `obj` are all strings)
  if (obj === undefined) return [];
  if (Array.isArray(obj)) {
    if (Array.isArray(obj[0])) {
      return obj;
    }
    return obj .. transform(function(s) {
      var rv = splitter(s);
      if (rv.length !== 2) {
        throw new Error("Invalid format for #{name} setting (expected \"key=value\"): #{s}");
      }
      return rv;
    });
  } else {
    return obj .. object.ownPropertyPairs;
  }
};

var InternalOptions = function() { };
var sanitizeOpts = function(opts) {
  // sanitizes / canonicalizes opts.
  // Used by every function in this module so that they can
  // assume sane opts.
  opts = opts || {};
  if (opts instanceof(InternalOptions)) return opts;
  var rv = new InternalOptions();

  // require no processing:
  rv.compile = opts.compile;
  rv.sources = opts.sources;
  rv.output = opts.output;
  rv.dump = opts.dump;
  rv.strip = opts.strip;
  rv.strict  = !opts.skipFailed;  // srtict should be true by default

  // convert resources & hubs to array pairs with expanded paths:
  rv.resources = opts.resources .. toPairs(s -> s .. rsplit('=', 1), 'resources') .. map([path, alias] -> [alias, coerceToURL(path)]);
  rv.hubs =      opts.hubs      .. toPairs(s -> s .. split('=', 1), 'hubs')  .. map([prefix, path] -> [prefix, coerceToURL(path)]);

  // expand ignore / exclude paths
  rv.exclude = (opts.exclude || []) .. map(coerceToURL) .. map(wildcardToRe);
  rv.ignore  = (opts.ignore  || []) .. map(coerceToURL) .. concat([/^builtin:/, /\.api$/, /^nodejs:/]) .. map(wildcardToRe);
  rv.include = (opts.include || []) .. map(coerceToURL) .. map(wildcardToRe);
  return rv;
};

exports.create = function(opts) {
  opts = sanitizeOpts(opts);

  var commonSettings = {
    compile: opts.compile,
  };

  var deps = findDependencies(opts.sources, opts);

  if (opts.dump)
    return deps;

  logging.verbose("got dependencies:\n" + JSON.stringify(deps, null, "  "));

  var contents = generateBundle(deps, opts);

  if (opts.output) {
    var write = function(output) {
      var {Buffer} = require('nodejs:buffer');
      contents .. each { |line|
        var buf = new Buffer(line + "\n");
        fs.write(output, buf, 0, buf.length);
      }
      logging.info("wrote #{opts.output}");
    };

    if (opts.output == '-') {
      write(process.stdout.fd);
    } else {
      using (var output = fs.open(opts.output, 'w')) {
        write(output);
      }
    }
    return deps;
  } else {
    return contents;
  }
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
        names: ['quiet','q'],
        help: 'Decrease log level',
        type: 'arrayOfBool',
      },
      {
        name: 'resource',
        type: 'arrayOfString',
        help: (
          'Set the runtime URL (or server path) for an on-disk location, e.g: ' +
          '--resource components=/static/sjs/components ' +
          '--resource /lib/nodejs/sjs=http://example.org/sjs ' +
          "NOTE: The URLs used here must match the URLs used by your running application, " +
          "otherwise the bundled version will be ignored."
        ),
      },
      {
        name: 'hub',
        type: 'arrayOfString',
        help: (
          'Add a compile-time require.hub alias - only used to resolve ' +
          'files at bundle-time (see `--resource` for configuring runtime URLs). e.g.: ' +
          '--hub lib:=components/'
        ),
      },
      {
        names: ['config', 'c'],
        type: 'string',
        helpArg: 'FILE',
        help: "Extend command line options with JSON object from FILE",
      },
      {
        name: 'compile',
        type: 'bool',
        help: "Precompile to JS (larger filesize, quicker execution)",
      },
      {
        name: 'strip',
        type: 'bool',
        help: "Strip dead code (experimental)",
      },
      {
        name: 'dump',
        type: 'bool',
        help: "Print dependency info (JSON)",
      },
      {
        name: 'output',
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
        helpArg : 'GLOB',
        help: "ignore all modules matching GLOB",
      },
      {
        name: 'exclude',
        type: 'arrayOfString',
        helpArg : 'GLOB',
        help: "exclude modules matching GLOB from bundle output (they are still parsed for dependencies, but omitted from the bundle. Use --ignore to skip modules entirely)",
      },
      {
        name: 'include',
        type: 'arrayOfString',
        helpArg : 'GLOB',
        help: "include modules that are excluded by default (using the @bundle-exclude annotation)",
      },
    ]
  });

  var opts = parser.parse();

  var usage = function() {
    var path = require('nodejs:path');
    process.stderr.write("Usage: #{path.basename(process.argv[0])} #{process.argv[1]} [OPTIONS] [SOURCE [...]]\n\n");
    process.stderr.write(parser.help());
  };

  if (opts.help) {
    usage();
    process.exit(0);
  }

  var verbosity = (opts.verbose ? opts.verbose.length : 0)
                - (opts.quiet   ? opts.quiet.length   : 0);
  if (verbosity) {
    logging.setLevel(logging.getLevel() + (verbosity * 10));
  }

  // pluralize "resource" and "hub" config keys from dashdash
  ;[ ['resource', 'resources'], ['hub', 'hubs' ] ] .. each {|[orig,plural]|
    if (opts .. object.hasOwn(orig)) {
      opts[plural] = opts[orig];
    }
  };
  
  opts.sources = opts._args;

  if (opts.config) {
    var config = fs.readFile(opts.config).toString() .. JSON.parse();
    opts = object.merge(opts, config);
  }

  if (!(opts.dump || opts.output)) {
    usage();
    console.error();
    console.error("Error: One of --output or --dump options are required");
    process.exit(1);
  }

  if (opts.dump) opts.output = null;

  var deps = exports.create(opts);

  if (opts.dump) {
    console.log(JSON.stringify(deps, null, '  '));
    process.exit(0);
  }
  
}
