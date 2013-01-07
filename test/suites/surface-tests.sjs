var testUtil = require('../lib/testUtil');
var test = testUtil.test;

if(testUtil.isBrowser) {
  var surface = require("apollo:surface/base");
  var Template = require("apollo:surface/template").Template;


  // Checks that the created DOM element contains what we expect:
  var test_roundtrip = function(desc, html, expected) {
    test(desc, expected || html, function() {
      return surface.Html(html).dompeer.outerHTML;
    });
  }

  test_roundtrip(
    "Node at top-level",
    "<div>Hi there</div>"
  );

  test_roundtrip(
    "Text only",
    "Hi there",
    "<surface-ui>Hi there</surface-ui>"
  );

  test_roundtrip(
    "Mix of elements and text nodes at top level",
    "<em>Hello,</em> friend!",
    "<surface-ui><em>Hello,</em> friend!</surface-ui>"
  );


  var logging = require("apollo:logging");
  logging.setLevel(logging.INFO);

  var _debug = function(fn) {
    return function() {
      using(logging.logContext({level:logging.DEBUG})) {
        return fn();
      }
    }
  };

  test("Basic template interpolation", "<h1 class=\"firstname\">John</h1>", function() {
    return Template("<h1 class=\"{type}\">{name}</h1>").render({
      type: "firstname",
      name: "John"}).dompeer.outerHTML;
  });

  test("Escaping of special characters", "&lt;script&gt; \"quote's\"", function() {
    return Template("{0} {1}").render(["<script>", "\"quote's\""]).dompeer.innerHTML;
  });

  test("Resistance to value interpolation", "{second_val} \\{braces\\}", function() {
    return Template("{val} {br}").render({val: "{second_val}", second_val: "injected!", br:"\\{braces\\}"}).dompeer.innerHTML;
  });

  test("Pathed lookup of variables", "John Smith", function() {
    return Template("{name.first} {name.last}").render({name: {first: "John", last:"Smith"}}).dompeer.innerHTML;
  });

  test("Escaping braces", "<div x=\"{x}\">John {last}</div>", _debug(function() {
    return Template("<div x=\"\\{x\\}\"/>{first} \\{last\\}</div>").render({x: "x", first: "John", last:"Smith"}).dompeer.outerHTML;
  }));

  test("Function result used", "val", function() {
    return Template("{fn}").render(
      {
        fn: function() { return "val"}
      }).dompeer.innerHTML;
  });

  test("Function gets render values as single argument", "John Smith (Smithy)", function() {
    return Template("{first} {last} ({nickname})").render(
      {
        first: "John",
        last:"Smith",
        nickname: function(vals) { return vals.last + "y";}
      }).dompeer.innerHTML;
  });

  test("Rendering of nulls / undefined", "[] []", function() {
    return Template("[{a}] [{b}]").render({b:null}).dompeer.innerHTML;
  });

  test("Sub-templates are rendered with the same context", "<div><h1>title</h1><p>body</p></div>", function() {
    return Template("<div><h1>{t}</h1>{b}</div>").render({t:"title", b: Template("<p>{p}</p>"), p: "body"}).dompeer.outerHTML;
  });

  test("Strict mode throws an error if substitutions are undefined", "Undefined template substitution: foo.bar", function() {
    try {
      Template("{foo.bar}").render({}, {strict: true});
      return "No exception thrown!";
    }
  });

  test("Strict mode throws an error if substitutions are undefined", "Undefined template substitution: foo.bar", function() {
    try {
      Template({content: "{foo.bar}"}).render({});
      return "No exception thrown!";
    }
  });

  // TODO: - non-content (mechanism, class, etc) attributes properly applied to sub-templates?
  //       - copying of various things, make sure things are aliased appropriately

}
