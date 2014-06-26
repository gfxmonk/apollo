var {test, context, assert} = @ = require('sjs:test/std');
var { @TemporaryDir } = require('sjs:nodejs/tempfile');
var { @rimraf } = require('sjs:nodejs/rimraf');

context {||

  var fs = require('sjs:nodejs/fs');
  var path = require('nodejs:path');
  var object = require('sjs:object');
  var url = require('sjs:url');
  var seq = require('sjs:sequence');
  var arr = require('sjs:array');
  var { each, map, hasElem } = seq;

  var bundle = require('sjs:bundle');
  var basePath = url.normalize('./', module.id) .. url.toPath;

  var tmpfile = path.join(process.env['TEMP'] || '/tmp', 'sjs-test-bundle.js');
  var createdBundles = [];
  test.afterAll {||
    createdBundles .. each {|f|
      if(fs.exists(f)) fs.unlink(f);
    }
  }

  var evaluateBundle = function(contents) {
    // set up some "globals"
    var __oni_rt_bundle = {};
    var document = {
      location: {
        origin: 'HOST'
      }
    };

    eval(contents);
    return __oni_rt_bundle;
  };

  var createBundle = function(settings) {
    settings = {"output":tmpfile} .. object.merge(settings);
    var output = settings.output;
    if(output && !createdBundles .. hasElem(settings.output)) {
      createdBundles.push(settings.output);
    }

    var contents = bundle.create(settings);
    if(output) {
      contents = fs.readFile(settings.output).toString();
    } else {
      contents = contents .. seq.join('\n');
    }

    return evaluateBundle(contents);
  }

  var bundledModuleNames = function(bundle) {
    var rv = object.ownPropertyPairs(bundle.h) .. seq.sortBy(h -> h[0]) .. seq.map([name, entries] -> [name, entries .. seq.map(e -> e[0])]);
    var modules = object.ownKeys(bundle.m) .. seq.toArray();
    if (modules.length > 0) {
      rv.push([null, modules]);
    }
    return rv;
  };

  var fixtureUrl = url.normalize('./fixtures/', module.id);
  var fixtureDependencies = [
    '/fixtures/annotated_child1.sjs',
    '/fixtures/annotated_child2.sjs',
    '/fixtures/bundle_parent.sjs',
    '/fixtures/child1.sjs',
    '/fixtures/dynamic_dependency.sjs',
    '/fixtures/merge_child1.sjs',
    '/fixtures/merge_child2.sjs',
  ];

  var fixtureDependencyUrls = fixtureDependencies .. map(d -> 'HOST' + d);

  test("includes module dependencies") {||
    var bundle = createBundle({
      resources: ["#{basePath}=/"],
      sources: [
        'sjs:xbrowser/console',
        fixtureUrl + 'bundle_parent.sjs'
      ],
    });

    bundle .. bundledModuleNames .. assert.eq([
      [ 'sjs:', [
        'array.sjs',
        'cutil.sjs',
        'debug.sjs',
        'event.sjs',
        'logging.sjs',
        'object.sjs',
        'quasi.sjs',
        'regexp.sjs',
        'sequence.sjs',
        'string.sjs',
        'xbrowser/console.sjs',
        'xbrowser/dom.sjs',
        ]],
      [ null, fixtureDependencyUrls]
    ]);
  }

  context("multiple bundles") {||
    test("excludes modules that are present in an existing bundle") {||
      var settings = {
        resources: ["#{basePath}=/"],
        output: tmpfile,
        sources: [ fixtureUrl + 'child1.sjs' ],
      };
      var bundle = createBundle(settings) .. bundledModuleNames;
      var bundle2 = createBundle(settings .. object.merge({
        output: null,
        excludeFrom:[tmpfile],
        sources: [fixtureUrl + 'bundle_parent.sjs']})) .. bundledModuleNames;

      var expectedDeps = fixtureDependencyUrls.slice();
      expectedDeps .. arr.remove('HOST/fixtures/child1.sjs') .. assert.ok();
      bundle2 .. assert.eq([[null, expectedDeps]]);
    }.skip("Not yet implemented");

    test("can load existing bundles") {||
      bundle.create({
        sources: ['sjs:sys', fixtureUrl + 'bundle_parent.sjs'],
        resources: ["#{basePath}=/"],
        output: tmpfile,
      });

      var contents = bundle.contents(tmpfile);
      contents .. assert.eq([ 'sjs:sys.sjs' ].concat(fixtureDependencies));
    }

    test("only root (non-alias) hubs are included in the result") {||
      var deps = createBundle({
        hubs: ["foo:=sjs:"],
        sources: ['foo:sys'],
        compile: true,
      }) .. bundledModuleNames();
      deps.map(d -> d[0]) .. assert.eq(['sjs:']);
      deps[0][1] .. assert.contains('sys.sjs');
    }
  }

  test("resources can be given as object properties") {||
    var resources = {};
    resources[basePath] = "/";
    var [hub, modules] = createBundle({
      resources: resources,
      sources: [fixtureUrl + 'utf8.sjs'],
    }) .. bundledModuleNames() .. seq.at(0);

    modules .. assert.contains('HOST/fixtures/utf8.sjs');
  }

  test("precompilation produces JS function sources") {||
    var modules = createBundle({
      sources: ['sjs:xbrowser/console'],
      compile: true,
    }).h['sjs:'];

    assert.ok(modules.length > 0);

    modules.map(m -> m[1]) .. each {|mod|
      String(typeof(mod)) .. assert.eq('function');
    }
  }

  context("dead code removal") {||
    test.beforeEach {|s|
      s.tmp = @TemporaryDir({prefix:'bundle-test'});
      s.bundleSettings = {
        strip: true,
        resources: [[s.tmp, '']],
        compile:true,
      };

      var basename = url -> url.replace(/^.*\//, '').replace(/\.sjs$/, '')

      @fs.writeFile(@path.join(s.tmp, 'dep_a.sjs'), '// intentionally blank');
      @fs.writeFile(@path.join(s.tmp, 'dep_b.sjs'), '// intentionally blank');

      s.getDeps = function dependUpon(propertyNames, modsrc) {
        @fs.writeFile(@path.join(s.tmp, 'lib.sjs'), modsrc);
        var mainPath = @path.join(s.tmp, 'main.sjs');
        @fs.writeFile(mainPath, "
        var mod = require('./lib');
        #{propertyNames .. @map(p -> "console.log(mod.#{p});\n")}
        ");
        var deps = bundle.findDependencies( [mainPath], s.bundleSettings);
        var rv = {
          all: deps,
        };
        deps.modules .. @ownPropertyPairs .. @each {|[k,v]|
          rv[basename(k)] = v;
        }
        @info("deps: ", rv);
        return rv;
      };

      s.getExports = function(deps) {
        var contents = bundle.generateBundle(deps.all, s.bundleSettings) .. @join('\n');
        var modules = evaluateBundle(contents).m
          .. @ownPropertyPairs
          .. @map(([k,v]) -> [basename(k),v])
          .. @pairsToObject();

        var libModule = modules .. @get('lib');

        var makeDescriptor = function() {
        };

        var moduleCache = {};
        var loadModule = function(id) {
          id = basename(id);
          if (!moduleCache .. @hasOwn(id)) {
            @info("Loading: ", id);
            var desc = {
              exports: {},
              require: function(mods) {
                if (!Array.isArray(mods)) mods = [mods];
                @info("requiring: ", mods);
                var exports = mods .. @map(function(mod) {
                  if (@isString(mod)) mod = {id:mod};
                  var exports = loadModule(mod .. @get('id'));
                  if ('name' in mod) {
                    var rv = {};
                    rv[mod.name] = exports;
                    exports = rv;
                  }
                  return exports;
                });
                @info ("merging exports:", exports);
                return exports .. @merge();
              },
              __onimodulename: id,
              __oni_altns: {},
            };
            desc.module = {exports: desc.exports};

            if (id === 'builtin:apollo-sys') {
              return require(id);
            }

            var argNames = require.extensions['sjs'].module_args;
            var flatArgs = argNames .. @map(k -> desc .. @get(k));
            var moduleBody = modules .. @get(id);
            @info("evaluating: " + moduleBody);
            moduleCache[id] = desc;
            (moduleBody).apply(null, flatArgs);
            @info("got exports:", desc.module.exports);
          }
          return moduleCache[id].module.exports;
        }

        return loadModule('lib');
      };
 
    }
    test.afterEach {|s|
      @rimraf(s.tmp);
    }


    test("basic dependency") {|s|
      var deps = s.getDeps(['fun2'], '
        var needed_by_fun1 = "fun1+2 result";
        var needed_by_fun3 = "fun3 result";

        exports.fun1 = function() {
          return needed_by_fun1;
        };

        exports.fun2 = function() {
          return exports.fun1();
        };

        exports.fun3 = function() {
          return needed_by_fun3;
        };
      ');

      var exports = s.getExports(deps);

      deps.lib.exports .. @sort .. @assert.eq(['fun2']);
      exports .. @ownKeys .. @assert.contains('fun1');
      exports .. @ownKeys .. @assert.notContains('fun3');
      exports.fun2() .. @assert.eq('fun1+2 result');
    }

    test("__js blocks") {|s|
      var deps = s.getDeps(['fun2'], '
        var needed_by_fun1 = "fun1+2 result";
        var needed_by_fun3 = "fun3 result";

        __js {
        exports.fun1 = function() {
          return needed_by_fun1;
        };
        }

        exports.fun2 = function() {
          return exports.fun1();
        };

        exports.fun3 = function() {
          return needed_by_fun3;
        };
      ');

      var exports = s.getExports(deps);

      deps.lib.exports .. @sort .. @assert.eq(['fun2']);
      exports .. @ownKeys .. @assert.contains('fun1');
      exports .. @ownKeys .. @assert.notContains('fun3');
      exports.fun2() .. @assert.eq('fun1+2 result');
    }

    test("selective dependency on secondary module") {|s|
      var modsrc = '
        var dep_a = require("./dep_a");
        var dep_b = require("./dep_b");
      
        function get_b_a() { return dep_b.a; }

        exports.needs_a_a = function() {
          return dep_a.a();
        };

        exports.needs_a_all = function() {
          return dep_a;
        }

        exports.needs_b_a = function() {
          return get_b_a();
        }
      ';

      var deps = s.getDeps(['needs_a_a'], modsrc);
      deps .. @ownKeys .. @assert.notContains('dep_b');
      deps.dep_a.exports .. @sort .. @assert.eq(['a']);

      deps = s.getDeps(['needs_a_all'], modsrc);
      deps .. @ownKeys .. @assert.notContains('dep_b');
      deps.dep_a.exports .. @assert.contains(null);

      deps = s.getDeps(['needs_b_a'], modsrc);
      deps .. @ownKeys .. @assert.notContains('dep_a');
      deps.dep_b.exports .. @assert.eq(['a']);
    }

    test("single module assigned to @altns") {|s|
      var deps = s.getDeps(['fun'], '
        @ = require("./dep_a");
        @foo();
        exports.fun = function() {
          @bar();
        }
      ');
      deps.dep_a.exports .. @sort .. @assert.eq(['bar','foo']);
    }

    test("multiple modules assigned to @altns") {|s|
      var deps = s.getDeps(['fun'], '
        @ = require(["./dep_a", "./dep_b"]);
        @foo();
        exports.fun = function() {
          @bar();
        }
      ');
      // we assume `foo` and `bar` come from either a or b
      // (dead code will ignore properties for which no actual code is found)
      deps.dep_a.exports .. @sort .. @assert.eq(['bar','foo']);
      deps.dep_b.exports .. @sort .. @assert.eq(['bar','foo']);
    }

    test("multiple assignment") {|s|
      var exports = s.getDeps(['fun1'], '
        var _x = exports.fun1 = function() {
          return "fun1";
        }
      ') .. s.getExports;
      exports.fun1() .. @assert.eq("fun1");
    };

    test("multiple complex require() arguments") {|s|
      var deps = s.getDeps(['main'], '
        @ = require([{id: "./dep_a", name: "module_a"}, "./dep_b"]);
        @module_a.foo();
        @bar();
      ');

      // @module_a.foo can be statically determined to be equivalent to
      // require("./module_a").foo
      //
      // Likewise, we know that @bar cannot come from dep_a
      deps.dep_a.exports .. @sort .. @assert.eq(['foo']);
      deps.dep_b.exports .. @sort .. @assert.eq(['bar']);
    }

    test("assignments to global references") {|s|
      var exports = s.getDeps(['main'], '
        process.test_process_property = "assigned from bundle";
      ') .. s.getExports();
      process.test_process_property .. @assert.eq("assigned from bundle");
    }.ignoreLeaks("test_process_property");

    test("referencing `exports` directly") {|s|
      var moduleSrc = '
        function get_it(obj) {
          return obj.prop;
        };

        exports.run = function() {
          return get_it(exports);
        };

        exports.run_specific = function() {
          return exports.prop;
        };

        exports.prop = "export prop!";
        exports.unused = "unused";
      ';

      var deps = s.getDeps(['run'], moduleSrc);
      var exports = s.getExports(deps);
      exports.run() .. @assert.eq("export prop!");
      exports .. @ownKeys .. @sort .. @assert.contains('unused');
      

      var deps = s.getDeps(['run_specific'], moduleSrc);
      var exports = s.getExports(deps);
      exports.run_specific() .. @assert.eq("export prop!");
      exports .. @ownKeys .. @sort .. @assert.notContains('unused');
    }

    test("assigning to module.exports directly") {|s|
      var exports = s.getDeps(['run'], '
        var x = module.exports = function() {
          return "module function!";
        }
        x.prop = "property!";
      ') .. s.getExports();
      exports() .. @assert.eq("module function!");
      exports.prop .. @assert.eq("property!");
    }

    context("modules that re-export their dependencies") {||
      test.beforeEach {|s|
        @fs.writeFile(@path.join(s.tmp, "sub_full"), '
          exports.full1 = "full 1";
          exports.full2 = "full 2";
        ');

        @fs.writeFile(@path.join(s.tmp, "sub_individual"), '
          exports.individual1 = "individual 1";
          exports.individual2 = "individual 2";
        ');

        s.stdlibDeps = function(contents) {
          @fs.writeFile(@path.join(s.tmp, "std.sjs"), contents);
          var deps = s.getDeps(['run'], '
            var m = require("./std");
            exports.run = function() {
              return [
                m.individual.individual1,
                m.full1
              ];
            }
          ');

          deps .. @ownKeys .. @filter(x -> x !== 'all') .. @sort .. @assert.eq(['lib', 'main', 'std', 'sub_full','sub_individual']);
          return deps;
        };
      }

      test("static") {|s|
        var deps = s.stdlibDeps('
          /**
            @re-exports-dependencies
          */

          module.exports = require([
            "./sub_full",
            {id: "./sub_individual", name:"individual"},
          ]);
        ');
        deps.sub_full.exports .. @sort .. @assert.eq(['full1']);
        deps.sub_individual.exports .. @sort .. @assert.eq(['individual1']);
        var exports = s.getExports(deps);
        exports.run() .. @assert.eq(['individual 1', 'full 1']);
      }

      test("dynamic (but deterministic) module sets") {|s|
        var deps = s.stdlibDeps('
          /**
            @re-exports-dependencies
          */

          var req = [
            "./sub_full",
          ];
          req = req.concat([
            {id: "./sub_individual", name:"individual"},
          ]);
          module.exports = require(req);
        ');
        // due to multiple possible values of `req` variable,
        // we can't tell precisely where `individual` comes from:
        deps.sub_full.exports .. @sort .. @assert.eq(['full1', 'individual']);
        
        deps.sub_individual.exports .. @sort .. @assert.eq(['individual1']);
        var exports = s.getExports(deps);
        exports.run() .. @assert.eq(['individual 1', 'full 1']);
      }

      test("hostenv-specific module sets") {|s|
        // XXX right now we accumulate _all_ possible values of
        // `req`. If we add explicit static support for `hostenv` checks
        // then we'll need to adjust this test accordingly
        var deps = s.stdlibDeps('
          /**
            @re-exports-dependencies
          */

          var req = [];
          var sys = require("builtin:apollo-sys");
          if (sys.hostenv === "nodejs") {
            req = req.concat({id: "./sub_individual", name:"individual"});
          } else
            req = req.concat("./sub_full");
          module.exports = require(req);
        ');

        // due to multiple possible values of `req` variable,
        // we can't tell precisely where `individual1` comes from:
        deps.sub_full.exports .. @sort .. @assert.eq(['full1', 'individual']);
        
        deps.sub_individual.exports .. @sort .. @assert.eq(['individual1']);
        var exports = s.getExports(deps);
 
        // executed on nodejs, so we don't actually import `sub_full` at runtime
        exports.run() .. @assert.eq(['individual 1', undefined]);
      }
    }

    test('modules which are incidentally imported alongside a used module are blank') {|s|
      @fs.writeFile(@path.join(s.tmp, 'dep_a.sjs'), 'exports.aa = "aa";');
      @fs.writeFile(@path.join(s.tmp, 'dep_b.sjs'), '
        throw new Error("dep_b module contents was included");
      ');

      // bundler can determine that @aa is provided by ./dep_a, so
      // dep_b is actually unused (but still required in the bundle)

      var exports = s.getDeps(['run'], "
        @ = require(['./dep_a', './dep_b']);
        exports.run = function() {
          return @aa;
        }
      ") .. s.getExports;
      exports.run() .. @assert.eq('aa');
    }

    test('side-effect modules are kept') {|s|
      // if we require() a module and don't assign the results
      // anywhere, that module's non-export statements should
      // be included under the assumption it's being required
      // for its side effects.
      @fs.writeFile(@path.join(s.tmp, 'dep_a.sjs'), 'throw new Error("a was imported")');
      var deps = s.getDeps(['run'], "
        require('./dep_a');
        exports.run = 1;
      ");
      assert.raises({message: 'a was imported'}, -> s.getExports(deps));
    }
  }

}.serverOnly();
