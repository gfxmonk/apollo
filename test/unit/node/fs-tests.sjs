@ = require('sjs:test/std');

@context {||
  @stream = require('sjs:nodejs/stream');
  @test.beforeAll {|s|
    s.root = @path.join(process.env['TEMPDIR'] || process.env['TEMP'] || '/tmp', 'sjs-fs-tests');
    if (!@fs.isDirectory(s.root)) {
      @fs.mkdir(s.root);
    }
    s.path = -> @path.join.apply(null, [s.root].concat(arguments .. @toArray));
  }

  @test.afterAll {|s|
    @childProcess.run('rm', ['-r', s.root], {stdio:'inherit'});
  }
    
  @context("WriteStream") {||
    @test("works") {|s|
      @fs.withWriteStream(s.path('output')) {|f|
        f .. @stream.write('data');
      }
      @fs.readFile(s.path('output'), 'utf-8') .. @assert.eq('data');
    }

    @test("it's OK to call end() twice") {|s|
      @fs.withWriteStream(s.path('output')) {|f|
        f .. @stream.write('data');
        f.end();
      }
      @fs.readFile(s.path('output'), 'utf-8') .. @assert.eq('data');
    }

    @test("throws correct error for error opening file") {||
      @assert.raises({filter: e -> e.code === 'EACCES' || e.code === 'EPERM' }) {||
        @fs.withWriteStream('/cant_access_this_file', -> null);
      }
    }
  }

  @context("ReadStream") {||
    @test.beforeAll() {|s|
      @fs.writeFile(s.path('data'), 'Hello world', 'utf-8');
    }

    @test("works") {|s|
      var contents;
      @fs.withReadStream(s.path('data'), {encoding:'utf-8'}) {|f|
        contents = f .. @stream.read();
      }
      contents .. @assert.eq('Hello world');
    }

    @test("it's OK to call destroy() twice") {|s|
      @fs.withReadStream(s.path('output')) {|f|
        f .. @stream.read();
        f.destroy();
      }
    }

    @test("throws correct error for error opening file") {||
      @assert.raises({filter: e -> e.code === 'ENOENT'}) {||
        @fs.withReadStream('/cant_access_this_file', -> null);
      }
    }
  }
}.serverOnly();
