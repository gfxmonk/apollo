/*
 * C1 Stratified JavaScript parser 
 *
 * Part of StratifiedJS
 * http://onilabs.com/stratifiedjs
 *
 * (c) 2011 Oni Labs, http://onilabs.com
 *
 * This file is licensed under the terms of the GPL v2, see
 * http://www.gnu.org/licenses/gpl-2.0.html
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

/*

 *** OVERVIEW ***

 This parser needs to be preprocessed with CPP (the C preprocessor)
 and a 'kernel' file to yield a full compiler. There are currently
 three kernels, each implementing a different compiler:
 
  kernel-js.js.in    : plain JS compiler (just for sanity checking)
  kernel-jsmin.js.in : JS/SJS minifier/stringifier
  kernel-sjs.js.in   : SJS compiler (targetting stratifiedjs vm)

 Which kernel file is included is determined by preprocessor flags;
 see below.

 For each JS construct, the parser makes a macro call, e.g. GEN_WHILE
 for a 'while' statement. The actual macro implementations are in the
 kernel files - see the full list of macros that kernel files need to
 implement below.

 This somewhat weird arrangement is so that we can build different
 compilers from the same parser source, but we don't have to build a
 generic AST. A generic AST (like e.g. Narcissus produces it) needs to
 be retraversed to do something useful with it, whereas with the macro
 approach we can perform syntax-directed translation tasks at the same
 time as parsing the source. We could use function calls instead of
 macros, but macros lead to smaller source and faster compilers.

 Most of the macros are expected to return a "parse value" for the
 given construct (this can be a syntax tree node, a string, nothing,
 or whatever). The parser feeds the parse values of expressions to the
 enclosing expression. The ultimate result of the compilation is
 whatever END_SCRIPT() returns. E.g. the following program:

  1 + 2

 would generate something like the following sequence of macro calls:

  BEGIN_SCRIPT(context)
  GEN_LITERAL("number", "1", ctx) // remember return value as 'A'
  GEN_LITERAL("number", "2", ctx) // remember return value as 'B'
  GEN_INFIX_OP(A, '+', B, ctx) // remember return value as 'C'
  GEN_EXP_STMT(C, ctx) // remember return value as 'D'
  ADD_SCRIPT_STMT(D, ctx)
  END_SCRIPT(ctx) // return value is the result of compilation

 The best way to understand how the macros fit together is to look at
 kernel-js.js.in.

 * INTERNALS

 As a parsing technique, we first tokenize the stream using two big
 context-sensitve regular expressions (TOKENIZER_SA and
 TOKENIZER_OP). The tokenizer switches between these two, depending on
 whether we're in a 'statement/argument' position, or in an 'operator'
 position - this is required because in JavaScript certain constructs
 have different meanings in different contexts. E.g. a '/' can be the
 start of a regular expression (in a "statement/argument" position) or
 a division operator (in an "operator position").

 Next, we use the "Pratt parsing technique"
 (http://en.wikipedia.org/wiki/Pratt_parser). This is a version of
 recursive descent parsing where we encode operator precedence
 information directly into semantic tokens (see 'SemanticToken' class,
 below). A good introduction to Pratt parsing for JS is at
 http://javascript.crockford.com/tdop/tdop.html. What Douglas
 Crockford calls 'lbp', 'nud', and 'led', we call 
 'excbp' (expression continuation binding power), 
 'expsf' (expression start function) and
 'excf'  (expression continuation function), respectively.


 *** PREPROCESSOR FLAGS ***

(These flags are also valid in kernel files)

one of these required:
   define C1_KERNEL_JS
   define C1_KERNEL_SJS
   define 
   define C1_KERNEL_JSMIN  : compiles with the given kernel (and sets #define SJS appropriately)

general:
   define DEBUG_C1 : c1 debugging
   define VERBOSE_COMPILE_ERRORS : extra detail on compile errors (only interesting when debugging c1)
   define ECMA_GETTERS_SETTERS : allow ecma-style getters/setters
   define SJS_CORE : parse core SJS statements (set below)
   define MULTILINE_STRINGS : allow strings to include newlines; map to '\n' (set below)
   define SJS_USING: parse SJS's "using" keyword
   define SJS___JS: parse SJS's "__js" keyword
   define SJS_DESTRUCTURE: allow destructuring assignments (see http://wiki.ecmascript.org/doku.php?id=harmony:destructuring)
   define SJS_BLOCKLAMBDA: allow block lambdas (see http://wiki.ecmascript.org/doku.php?id=strawman:block_lambda_revival)
   define SJS_ARROWS: allow arrays (fat & thin) (see http://wiki.ecmascript.org/doku.php?id=harmony:arrow_function_syntax ; coffeescript)
   define SJS_DOUBLEDOT: allow double dot call syntax
   define SJS_ALTERNATE_NAMESPACE: allow '@' and '@identifier'
   define INTERPOLATING_STRINGS: allow strings with ruby-like interpolation
   define QUASIS: allow quasi templates (`foo#{bar}baz`)
   define METHOD_DEFINITIONS: allows methods on objects to be specified like { a (pars) { body } }
   define ONE_SIDED_CONDITIONALS: allows `foo ? bar` expressions (i.e. `foo ? bar : baz` without alternative `baz`). in the `false` case they yield `undefined`

for C1_KERNEL_JSMIN:
   define STRINGIFY  : encodes minified js/sjs as a string.

for C1_KERNEL_SJS:  OBSOLETE! VERBOSE EXCEPTIONS ARE ALWAYS USED NOW, NOT
                    PREDICATED ON THIS FLAG ANYMORE
   define VERBOSE_EXCEPTIONS: add lineNumber/fileName info to VM nodes.
   
*/
/* define DEBUG_C1 1 */

/*

 *** MACROS TO BE IMPLEMENTED BY KERNEL FILES ***

Misc:
=====

HANDLE_NEWLINES(n, pctx)
  Note: only called for newlines outside of ml-strings!
  
Contexts:
=========

BEGIN_SCRIPT(pctx)
ADD_SCRIPT_STMT(stmt, pctx)
END_SCRIPT(pctx)

BEGIN_FBODY(pctx , implicit_return)
ADD_FBODY_STMT(stmt, pctx)
END_FBODY(pctx , implicit_return)
   'implicit_return' is a flag to indicate whether the function should return
   the value of its last expression. It is only meaningful when 
   'METHOD_DEFINITIONS' is turned on.

BEGIN_BLOCK(pctx)
ADD_BLOCK_STMT(stmt, pctx)
END_BLOCK(pctx)

BEGIN_CASE_CLAUSE(cexp, pctx)
ADD_CASE_CLAUSE_STMT(stmt, pctx)
END_CASE_CLAUSE(pctx)

- called for do-while/while/for/for-in bodies:
BEGIN_LOOP_SCOPE(pctx)
END_LOOP_SCOPE(pctx)

- called for switch bodies:
BEGIN_SWITCH_SCOPE(pctx)
END_SWITCH_SCOPE(pctx)

- if SJS_BLOCKLAMBDA is defined:
BEGIN_BLAMBDABODY(pctx)
ADD_BLAMBDABODY_STMT(stmt, pctx)
END_BLAMBDABODY(pctx)

Statements:
===========

GEN_EMPTY_STMT(pctx)
GEN_EXP_STMT(exp, pctx)
GEN_LBL_STMT(lbl, stmt, pctx)
GEN_FUN_DECL(fname, pars, body, pctx)
GEN_VAR_DECL(decls, pctx)
  decls = array of decl
  decl = [id_or_pattern, optional initializer]
GEN_IF(test, consequent, alternative, pctx)
GEN_DO_WHILE(body, test, pctx)
GEN_WHILE(test, body, pctx)
GEN_FOR(init_exp, decls, test_exp, inc_exp, body, pctx)
GEN_FOR_IN(lhs_exp, decl, obj_exp, body, pctx)
GEN_CONTINUE(lbl, pctx)
GEN_BREAK(lbl, pctx)
GEN_RETURN(exp, pctx)
GEN_WITH(exp, body, pctx)
GEN_SWITCH(exp, clauses, pctx)
GEN_THROW(exp, pctx)
GEN_TRY(block, crf, pctx)
    crf is [ [catch_id,catch_block,catchall?]|null, null, finally_block|null ]
    (ammended for SJS, see below)

Expressions:
============

GEN_INFIX_OP(left, id, right, pctx)
  id: + - * / % << >> >>> < > <= >= == != === !== & ^ | && || ,
      instanceof in
GEN_ASSIGN_OP(left, id, right, pctx)
  id: = *= /= %= += -= <<= >>= >>>= &= ^= |=
GEN_PREFIX_OP(id, right, pctx)
  id: ++ -- delete void typeof + - ~ ! (for SJS also: 'spawn')
GEN_POSTFIX_OP(left, id, pctx)
  id: ++ --
GEN_LITERAL(type, value, pctx)
GEN_IDENTIFIER(name, pctx)
GEN_OBJ_LIT(props, pctx)
  props : array of ["prop", string|id, val]
          if ECMA_GETTERS_SETTERS is defined, also:
                   ["get", string|id, function_body]
                   ["set", string|id, id, function_body]
          if SJS_DESTRUCTURE is defined, also: (destructure pattern)
                   ["pat", string|id, line]
          if METHOD_DEFINITIONS is defined, also:
                   ["method", string|id, function]
GEN_ARR_LIT(elements, pctx)
GEN_ELISION(pctx)
GEN_DOT_ACCESSOR(l, name, pctx)
GEN_NEW(exp, args, pctx)
GEN_IDX_ACCESSOR(l, idxexp, pctx)
GEN_FUN_CALL(l, args, pctx)
GEN_FUN_EXP(fname, pars, body, pctx, implicit_return)
  -- see END_FBODY above for 'implicit_return'
GEN_CONDITIONAL(test, consequent, alternative, pctx)
GEN_GROUP(e, pctx)
GEN_THIS(pctx)
GEN_TRUE(pctx)
GEN_FALSE(pctx)
GEN_NULL(pctx)

Stratified constructs:
======================

GEN_PREFIX_OP(id, right, pctx) takes another operator: 'spawn'

GEN_WAITFOR_ANDOR(op, blocks, crf, pctx)
  op: 'and' | 'or'
  crf: see GEN_TRY
BEGIN_SUSPEND_BLOCK(pctx)
END_SUSPEND_BLOCK(pctx)
GEN_SUSPEND(has_var, decls, block, crf, pctx)
GEN_COLLAPSE(pctx)
  crf: see GEN_TRY
GEN_TRY(block, crf, pctx) 
    crf is [ [catch_id,catch_block,catchall?]|null, retract_block|null, finally_block|null ]
    (instead of the non-SJS version above)

- if SJS_USING is set:

GEN_USING(isvar, vname, exp, body, pctx)

- if SJS___JS is set:

BEGIN___JS_BLOCK(pctx)
END___JS_BLOCK(pctx)
GEN___JS(body, pctx)

- if SJS_BLOCKLAMBDA is set:
GEN_BLOCKLAMBDA(pars, body, pctx)

- if SJS_ARROWS is set:
GEN_THIN_ARROW(body_exp, pctx)
GEN_THIN_ARROW_WITH_PARS(pars_exp, body_exp, pctx)
GEN_FAT_ARROW(body_exp, pctx)
GEN_FAT_ARROW_WITH_PARS(pars_exp, body_exp, pctx)

- if SJS_DOUBLEDOT is set
GEN_DOUBLEDOT_CALL(l, r, pctx)

- if SJS_ALTERNATE_NAMESPACE is set
GEN_ALTERNATE_NAMESPACE_OBJ(pctx)
GEN_ALTERNATE_NAMESPACE_IDENTIFIER(name, pctx)

- if INTERPOLATING_STRINGS is set:
GEN_INTERPOLATING_STR(parts, pctx)

- if QUASIS is set:
GEN_QUASI(parts, pctx) with even parts=strings, odd parts=expressions

*/


/*
 * C1 JS/SJS->require() analysis compiler kernel  
 *
 * Part of StratifiedJS
 * http://onilabs.com/apollo
 *
 * (c) 2013 Oni Labs, http://onilabs.com
 *
 * This file is licensed under the terms of the GPL v2, see
 * http://www.gnu.org/licenses/gpl-2.0.html
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

//----------------------------------------------------------------------
// helpers:

var DEP_LOG = function() {
  if (process.env['DEP_LOG']) {
    return function() { console.log.apply(this,arguments); };
  }
  return function() {};
}();

var Object_prototype = Object.getPrototypeOf({}); // not the same as Object.prototype in nodejs sandbox
var has = function(o,k) { return Object.prototype.hasOwnProperty.call(o,k); };
var str = function(obj) {
  if (obj == null) return '<null>';
  if (Array.isArray(obj)) {
    return "[" + obj.map(str).join(", ") + "]";
  }
  if (obj && (obj.toString === Object_prototype.toString)) {
    var pairs = [];
    for (var k in obj) {
      if (!has(obj,k)) continue;
      pairs.push(k + ": " + str(obj[k]));
    }
    return "{" + pairs.join(", ") + "}";
  }
  if (typeof(obj.toString) !== 'function') {
    return "[Object object]"; // ugh...
  }
  return String(obj);
};
var assert = function(cond, desc) { if (!cond) throw new Error(desc || "Assertion failed"); return cond };

var nonReentrantCounter = 0;
var nonReentrant = function(default_value, fn) {
  var id = nonReentrantCounter++;
  return function() {
    if (!this.reentrancy_state) this.reentrancy_state=[];
    if (this.reentrancy_state[id]) {
      DEP_LOG("reentrant on " + str(this) + ", returning default");
      return default_value;
    }
    this.reentrancy_state[id] = true;
    try {
      return fn.apply(this, arguments);
    } finally {
      this.reentrancy_state[id] = false;
    }
  }
}

var _scope_ctr = 1;
function Scope(parent, pctx) {
  this.scope = this;
  this._id = _scope_ctr++;
  this._parent = parent;
  this.variables = {};
  this.stmts = [];
  this.children = [];
  this.pctx = pctx;
  this.identifiers = [];
  this._this_var = new Variable('this', this);
  if (parent) parent.children.push(this);
};
Scope.prototype.toString = function() {
  return "Scope#" + this._id + "(" + str(this.variables) + ")";
}
Scope.prototype.add_ident = function(ident) {
  // when we generate an identifier, we don't know how it'll be used.
  // We store it on the current `scope`, and when each scope is
  // complete we turn unused identifiers into variable references
  this.identifiers.push(ident);
};

Scope.prototype.convert_unused_identifiers_into_references = function(stmt) {
  for (var i=0; i<this.identifiers.length; i++) {
    var ident = this.identifiers[i];
    if (!ident.used) {
      DEP_LOG("turning otherwise-unused Id into variable reference: " + ident);
      this.get_var(ident.name);
    } else {
      DEP_LOG("ident was used: " + str(ident));
    }
  }
  this.identifiers = [];
}

Scope.prototype.add_var = function(name) {
  if (name instanceof ObjectLit) {
    // destructuring object
    for (var i = 0; i<name.props; i++) {
      this.add_var(name.props[i][1]);
    }
    return;
  } else if (name instanceof ArrayLit) {
    // destructuring array
    for (var i=0; i<name.arr.length; i++) {
      this.add_var(name.arr[i]);
    }
    return;
  } else if (name instanceof Id) {
    name.use();
    name = name.name;
  }
  if (typeof(name) !== 'string') {
    throw new Error("weird name: " + str(name) + " // " + typeof(name));
  }

  if(Object.prototype.hasOwnProperty.call(this.variables, name)) {
    // console.warn("variable defined twice: " + name); // XXX
    return this.variables[name];
  }

  var ident = new Variable(name, this)
  this.variables[name] = ident;
  return ident;
};
Scope.prototype.get_var = function(v, direct) {
  assert(typeof(v) === 'string', "non-string variable: " + v);
  if (v === 'this') {
    // there's a `this` in every scope, but it doesn't affect
    // dependencies
    return this._this_var;
  }

  var variable;
  if (Object.prototype.hasOwnProperty.call(this.variables, v)) {
    variable = this.variables[v];
  } else if (this._parent) {
    variable = this._parent.get_var(v, true);
  } else {
    // console.warn("global variable reference: " + v); // XXX
    variable = this.add_var(v);
  }

  if (direct) {
    return variable;
  }

  // `direct` means access the variable (for internal use),
  // but default use gets a reference to the given variable
  DEP_LOG("ref() from get_var");
  return new Ref(variable, this.pctx);
};

function ModuleReference(arg, path) {
  this.arg = assert(arg, "null arguments given to ModuleReference");
  assert(Array.isArray(path), "empty path given to ModuleReference");
  this.path = path;
};
ModuleReference.prototype.toString = function() {
  return "ModuleReference(" + str(this.arg) + ", " + str(this.path) + ")";
};

function SelfReference() { };
SelfReference.prototype.is_self = true;
SelfReference.prototype.toString = function() {
  return "SelfReference()";
};

function tapLog(desc, val) {
  DEP_LOG(desc, val);
  return val;
}

var process_script = function(pctx) {
  return {
    toplevel: current_scope(pctx),
  };
}

var seq = function(exprs) {
  var r = Dynamic;
  for (var i=0; i<exprs.length; i++) {
    if (exprs[i]) r = r.seq(exprs[i]);
  }
  return r;
}

// Generic Data types:

var Maybe = function(x) { return x === undefiend ? Nothing() : Just(x); };

var Just = function(x) {
  return {
    defined: function() { return true; },
    map: function(f) { return Just(f(x)); },
    bind: function(f) { return f(x); },
    get: function() { return x; },
    getLazy: function(_) { return x; },
    orElse: function(_) { return this; },
    toString: function () { return "Just(" + str(x) + ")"; },
  };
};

var Nothing = function() {
  return {
    defined: function() { return false; },
    map: function() { return this; },
    get: function(d) { return d; },
    getLazy: function(fn) { return fn(); },
    bind: function(d) { return this; },
    orElse: function(d) { return d; },
    toString: function() { return "Nothing()"; },
  };
};

var map = function(arr, fn) {
  // [a] -> (a -> b) -> [b]
  var res = [];
  for (var i=0; i<arr.length; i++) {
    res[i] = fn(arr[i]);
  }
  return res;
}

var expandPossibleValues = function(arr) {
  // Used to convert an arry of possibleValues() results
  // into a singl combined PossibleValues result for the
  // entire array / argument list.
  //
  // e.g: permutations([["a","b"],["c","d"]])
  // -> [["a","c"], ["a","d"], ["b","c"], ["b","d"]]
  //
  // ** NOTE**: We treat empty possibleValues as if they
  // were a single [undefined] possibility, because
  // otherwise we'd ignore entire calls due to a single
  // dynamic element
  //
  // e.g: permutations([["a","b"],[]])
  // -> [["a",undefined], ["b",undefined]]
  //
  // As a special case, when _every_ element of `arr`
  // is empty, the entire return value is just []

  var set =[];
  var any = false;
  arr = arr.map(function(elem) {
    assert(Array.isArray(elem));
    if (elem.length == 0) return [undefined];
    any = true;
    return elem;
  });
  if (!any) return [];

  function inner(arr, prefix) {
    if (arr.length == 0) {
      set.push(prefix);
    } else {
      var rest = arr.slice(1);
      var head = arr[0];
      for (var i=0; i<head.length; i++) {
        inner(rest, prefix.concat([head[i]]));
      }
    }
  }
  inner(arr, []);
  return set;
};

// console.log(combinations([["a","b","c"],["d","e"],[]]));
// process.exit(1);

var concat = function(arr) {
  var rv = [];
  for (var i=0; i<arr.length; i++) {
    rv = rv.concat(arr[i]);
  }
  return rv;
};


// Minimal AST
//
// Static(x) represents a dependency that will definitely occur in the given scope
// (e.g "this module WILL require ./mod2").
//
// Dynamic(x) represents an upper bound of the dependency-relevant information
// in a given scope (e.g the symbol "foo" may be used, and it may come from
// either "./mod1" or "./mod2").

var applyScope = (function() {
  return function(obj, scope) {
    assert(typeof(scope) === 'string' || scope === null, "not a string: " + scope);
    if (!obj.exportScope) obj.exportScope = [];
    // assert(obj.exportScope === undefined, "can't scope " + obj + " to " + scope + " - already scoped to " + obj.exportScope);
    DEP_LOG("SCOPE(" + str(scope) + "): " + str(obj));
    obj.exportScope.push(scope);
  };
})();

// Dynamic also serves as the base for other syntax types:
var Dynamic = {
  // combinators
  seq: function(other) { return other; },
  dot: function(prop) { return Dynamic; },
  call: function(args) { return new Call(this, args); },

  // scope:
  exportScope: undefined,

  // values
  staticValue: Nothing,                 // statically-determined value (an eval()-able string)
  possibleValues: function() {          // default to just this.staticValue()
    return this.staticValue().map(function(val) { return [val]; }).get([]);
  },
  toString: function() { return "Dynamic()"; },
};

var BlockProto = Object.create(Dynamic);
BlockProto.toString = function() {
  return "Block{"+str(this.scope)+"}";
};
function Block(scope) {
  var rv = Object.create(BlockProto);
  rv.stmts = [];
  rv.scope = scope;
  // inherit everything (non-writable) from scope
  // TODO: when we've established that nothing actually
  // writes to scope, turn this into a simple inherit
  for (var k in scope) {
    if (k in rv) continue;
    var val = scope[k];
    if (typeof(val) === 'function') val = val.bind(scope);
    Object.defineProperty(rv, k, {value:val, writable:false});
  }
  return rv;
};

var Property = function(parent, text, pctx) {
  this.parent = parent;
  this.name = text;
  this.children = {};
  this.values = [];
}
Property.prototype = Object.create(Dynamic);
Property.prototype.staticValue = function() {
  var self = this;
  return this.parent.staticValue().map (function(val) {
    return val + "." + self.name;
  });
};
Property.prototype.toString = function() {
  return str(this.parent) + "." + this.name;
}
// Identifier
var __id_ctr = 0;
var Id = function(text, scope) {
  this.name = text;
  this.scope = scope;
  this.used = false;
  this._ctr = __id_ctr++;
  DEP_LOG("INIT ID: " + str(this));
};
Id.prototype = Object.create(Dynamic);
Id.prototype.toString = function() { return "Id#" + this._ctr + "(" + this.name + ")"; };
Id.prototype.use = function() {
  // mark this identifier as "used". At the end of each toplevel
  // stmt, we assume all unused identifiers are actually
  // reference expressions
  this.used = true;
};

// delegate `dot`, `assign`, etc to underlying variable
;['dot','assign', 'call', 'possibleValues'].forEach(function(method) {
  Id.prototype[method] = function() {
    this.use();
    var variable = this.scope.get_var(this.name);
    return variable[method].apply(variable, arguments);
  };
});

var Variable = function(text, scope) {
  this.name = text;
  this.scope = scope;
  this.export_scope = null;
  this.values = [];
  this.children = {};
  this.provides = [this];
};
Variable.prototype = Object.create(Dynamic);

Variable.prototype.possibleValues = nonReentrant([], function() {
  DEP_LOG("getting possible values from Variable " + this);
  DEP_LOG("value ASTs = " + str(this.values));
  var possible = this.values.map(function(v) {
    return v.possibleValues();
  });
  return concat(possible);
});

Variable.prototype.dot = Property.prototype.dot = function(name) {
  if (!has(this.children, name)) {
    this.children[name] = new Property(this, name);
  }
  return assert(this.children[name]);
};

Variable.prototype.assign = Property.prototype.assign = function(value) {
  DEP_LOG(str(this) + " assuming value: " + str(value));
  this.values.push(value);
};

Variable.prototype.toString = function() { return "Variable[#" + this.scope._id + "](" + this.name + ")"; };

var Ref = function(dest, pctx) {
  assert(dest, "Ref created with empty destination!");
  while(dest instanceof Ref) {
    dest = dest.dest;
  }
  this.dest = dest;
  this.pctx = pctx;
  pctx.current_stmt.add_reference(this);
};
Ref.prototype = Object.create(Dynamic);

Ref.prototype.call = function(args) {
  DEP_LOG("REF from call: " + str(this.dest));
  var call = this.dest.call(args, this.pctx);
  return new Ref(call, this.pctx);
};

Ref.prototype.possibleValues = function() {
  return this.dest.possibleValues();
};

Ref.prototype.deref = function() {
  this.pctx.current_stmt.remove_reference(this);
};

Ref.prototype.dot = function(name) {
  // since references are not shared, dotting a reference must mean
  // that the code _only_ accesses <foo>.prop, and not <foo> itself.
  var underlying = this.dest.dot(name);
  this.deref();
  DEP_LOG("REF from dot: " + str(underlying));
  return new Ref(underlying, this.pctx);
};

Ref.prototype.assign = function(value) {
  DEP_LOG("ASSIGNING TO " + this);
  return this.dest.assign(value);
};
Ref.prototype.toString = function() { return "Ref(" + this.dest + ")"; };


var Statement = function() {
  this.references = [];
  this.dependencies = [];
  this.moduleDependencies = [];
  this.stmt = null;
}
Statement.prototype = Object.create(Dynamic);
Statement.prototype.toString = function() {
  return 'Stmt{'+str(this.stmt) +'}';
};
Statement.prototype.add_reference = function(ref) {
  DEP_LOG("+REF: " + ref);
  this.references.push(ref);
};
Statement.prototype.remove_reference = function(ref) {
  DEP_LOG("+UNREF: " + ref);
  var idx = this.references.indexOf(ref);
  if (idx === -1) {
    DEP_LOG("Can't find reference: " + ref + " in list: " + str(this.references));
    // throw new Error("Can't find reference: " + ref + " in list: " + str(this.references));
  }
  this.references.splice(idx, 1);
};
Statement.prototype.set = function(stmt) {
  if (this.stmt) throw new Error("Can't re-assign " + this.stmt + " to " + stmt);
  DEP_LOG("Setting stmt to " + str(stmt));
  this.stmt = stmt;
};

Statement.prototype.calculateDependencies = function(toplevel) {
  this.calculateDirectDependencies(toplevel);
  // this.expandDependencies();
};

function determineModuleReferences(node, path) {
  DEP_LOG("determining module references from node " + str(node));
  var seen = [];
  var inner = function(node, path) {
    if (seen.indexOf(node) !== -1) {
      DEP_LOG("CYCLIC NODE: " + str(node));
      return [];
    }
    seen.push(node);
    var module = null;
    path = path ? path.slice() : [];

    DEP_LOG("Checking reference " + node +", path = " + str(path));
    while(true) {
      if (this.is_exports(node) && path.length == 0) {
        DEP_LOG("raw EXPORTS reference!");
        return [new SelfReference()];
      }

      if (node instanceof Property) {
        // keep traversing parent
        path.unshift(node.name);
        node = node.parent;
      } else if (node instanceof Call) {
        DEP_LOG("Checking call of: " + node.expr);
        if (node.expr === this.require) {
          DEP_LOG("a require call! args = " + str(node.args));
        }
        if (node.expr === this.require && node.args.length > 0) {
          var arg = node.args[0];
          var alternatives = arg.possibleValues();
          if (alternatives.length > 0) {
            DEP_LOG("Checking all possible argument values:" + str(alternatives));
            return alternatives.map(function(arg) {
              var moduleRef = new ModuleReference(arg, path);
              DEP_LOG("yup! require call:" + moduleRef);
              return moduleRef;
            });
          } else {
            DEP_LOG("NOT Checking all possible argument values (there are none):" + str(arg));
            return [];
          }
        } else {
          // not a require call - but maybe a property of some required module:
          path = [];
          node = node.expr;
        }
      } else if (node instanceof Variable) {
        var rv = [];
        for (var valIdx = 0; valIdx < node.values.length; valIdx++) {
          DEP_LOG("traversing variable " + node + " value: " + node.values[valIdx]);
          rv = rv.concat(inner.call(this, node.values[valIdx], path));
        }
        return rv;
      } else {
        DEP_LOG("unknown thing! " + node);
        module = null;
        return [];
      }
    }
  };
  return inner.apply(this, arguments);
};

Statement.prototype.calculateDirectDependencies = function(toplevel) {
  var stmts = toplevel.stmts;
  
  // statement dependencies:
  for (var i = 0; i < stmts.length; i++) {
    var stmt = stmts[i];
    if(stmt === this) continue;
    var provides = stmt.stmt.provides;
    if (!provides) continue;

    for (var p = 0; p<provides.length; p++) {
      var provided = provides[p];
      if (toplevel.is_exports(provided)) {
        DEP_LOG("Stmt " + stmt + " provides module.exports - adding self-reference");
        this.moduleDependencies.push(new SelfReference());
      }
    }

    for (var r = 0; r<this.references.length; r++) {
      var needed = this.references[r].dest;
      while(true) {
        if (provides.indexOf(needed) !== -1) {
          // DEP_LOG("stmt " + this + " depends on " + stmt + " because " + str(needed));
          if (this.dependencies.indexOf(stmt) == -1) {
            this.dependencies.push(stmt);
          }
        }
        if (needed instanceof Property) {
          // if we depend on `foo.bar`, we also depend
          // on any statement that provides `foo`
          needed = needed.parent;
        } else {
          break;
        }
      }
    }
  }

  // module dependencies:
  for (var i = 0; i < this.references.length; i++) {
    var node = this.references[i].dest;
    this.moduleDependencies = this.moduleDependencies.concat(
        toplevel.determineModuleReferences(node));
  }
};

var MultipleStatements = function(stmts) {
  this.stmts = stmts;
};
MultipleStatements.prototype = Object.create(Dynamic);
MultipleStatements.prototype.toString = function() {
  return "MultipleStatements" + str(this.stmts);
}
MultipleStatements.wrap = function(stmts) {
  if (stmts.length == 1) {
    return stmts[0];
  }
  return new MultipleStatements(stmts);
}

var Assignment = function(l, op, r, pctx) {
  this.left = l;
  this.op = op;
  this.right = r || Dynamic;
  var scope = current_scope(pctx);
  var provides = [];
  if (r instanceof Assignment) {
    // `x = y = z` provides both x & y
    provides = r.provides.slice();
  }
  provides.push(l);
  this.provides = provides;

  var isAssignment = op === '=';
  if (isAssignment) {
    DEP_LOG("Assigning " + str(l) + " = " + str(r));
    l.assign(r);
  }
}
Assignment.prototype = Object.create(Dynamic);
Assignment.prototype.toString = function() {
  return "Assignment(" + str(this.left) + " " + this.op + " " + str(this.right) + ")";
}

function expand_assignment(is_var, l, op, r, pctx, stmts) {
  // turn a single assignment into one or more primitive Assignment statements
  stmts = stmts || [];
  DEP_LOG("expanding assignment " + str(l) + str(op) + str(r));
  var scope = current_scope(pctx);
  var isAssignment = op === '=';

  var provide = function(l, r) {
    DEP_LOG("providing: " + str(l));
    if (!r) return; // just `var x`, not `var x = <exr>`
    if (l instanceof Id) {
      if (is_var) {
        l = current_scope(pctx).add_var(l.name);
      } else {
        l = current_scope(pctx).get_var(l.name, true /* don't wrap in a reference */);
      }
    }

    if (r instanceof Ref) {
      // plain assignments don't count as a use - `r` is only used when
      // `l` gets referenced / dotted / called
      r.deref();
      r = r.dest;
    }
    if (l instanceof Ref) {
      l.deref();
      l = l.dest;
    }

    if (l instanceof Variable || l instanceof Property) {
      stmts.push(new Assignment(l, op, r, pctx));
    } else if (l instanceof ObjectLit) {
      for (var i=0; i<l.props.length; i++) {
        var par = l.props[i];
        assert(par.length === 2);
        var _l = par[1];
        var _r = par[0];
        assert(_r instanceof Id, "Unexpected RHS in destructure pattern: " + _r);
        _r = r.dot(_r.name);
        DEP_LOG("Assigning " + _l + " -> " + _r);
        provide(_l, _r);
      }
    } else if (l instanceof ArrayLit) {
      for (var i=0; i<l.arr.length; i++) {
        var _l = l.arr[i];
        var _r = Dynamic;
        // if rhs is an arrayLit as well, we can actually associate
        // l & r pairs
        if (r instanceof ArrayLit) {
          _r = r.arr[i] || new Lit("undefined");
        }
        provide(_l, _r);
      }
    } else {
      DEP_LOG("Don't know how to provide lvalue: " + l);
    }
  }
  provide(l,r);
  DEP_LOG("compound assignment " + str(stmts));
  return stmts;
}

// A sequence of AST nodes (well, just two - successive sequences form a stick)
var Seq = function(a,b) {
  this.a = a;
  this.b = b;
};
Seq.prototype = Object.create(Dynamic);
Seq.prototype.seq = function(other) { return new Seq(this, other); };

/* calls apply to the second object in a seq */
Seq.prototype.call = function() { return new Seq(this.a, this.b.call.apply(this.b, arguments)); };
Seq.prototype.toString = function() { return "Seq(" + this.a + "," + this.b + ")"; };

// A function call
var Call = function(expr, args) {
  this.expr = expr;
  this.args = args;
  this.capturePossibleValues();
};
Call.prototype = Object.create(Dynamic);
Call.prototype.seq = function(other) { return new Seq(this, other); };
Call.prototype.dot = function(property) {
  return new Property(this, property);
};

Call.prototype.capturePossibleValues = function() {
  // capture possible values at expression parse time, in order
  // to better resolve cyclical values
  var expr = this.expr;
  if (expr instanceof Ref) expr = assert(expr.dest);
  if (expr instanceof Property) {
    this._possibleSubjects = expr.parent.possibleValues();
    DEP_LOG("captured _possibleSubjects of: " + str(this._possibleSubjects) + " from " + str(expr.parent));
    this._possibleArgs = this.args.slice(0,1).map(function(arg) { return arg.possibleValues(); });
    this._expr = this.expr;
  }
};

Call.prototype.possibleValues = nonReentrant([], function() {
  // XXX we're only implementing enough here to be useful
  // to the typical use case of concatenating array literals
  var rv = [];
  
  DEP_LOG("determining possible values of some method " + str(this));
  DEP_LOG("expr is " + str(this.expr));
  DEP_LOG("its parent is " + str(this.expr.parent));
  var expr = this._expr;
  if (expr) {
    DEP_LOG("determining possible values of method " + str(this));
    var possibleSubjects = this._possibleSubjects;
    DEP_LOG("possibleSubjects from " + str(expr.parent) + " are: " + str(possibleSubjects));

    for (var subji=0;subji<possibleSubjects.length;subji++) {
      var subject = possibleSubjects[subji];
      if (!Array.isArray(subject)) {
        DEP_LOG("Skipping non-array subject: " + str(subject));
        continue;
      }
      var method = Array.prototype[expr.name];
      if (!method) {
        DEP_LOG("can't statically resolve array method " + expr.name);
        continue;
      }


      var argPossibilities = expandPossibleValues(this._possibleArgs);
      DEP_LOG("argPossibilities = " + str(argPossibilities));
      for (var i=0; i<argPossibilities.length; i++) {
        try {
          var copy = subject.slice();
          var result = method.apply(copy, argPossibilities[i]);
          if (result) {
            rv.push(result);
          }
        } catch(e) {
          DEP_LOG("error statically resolving " + str(this) + ":\n" + e + "\n" + e.stack);
        }
      }
    }
  }
  DEP_LOG("possible value: -> " + str(rv));
  return rv;
});

// A primitive literal
var Lit = function(val) {
  this.val = val;
  // DEP_LOG(" # " + this);
};
Lit.prototype = Object.create(Dynamic);
Lit.prototype.staticValue = function() { return Just(eval(this.val)); };
Lit.prototype.toString = function() { return "Literal(" + this.staticValue() + ")"; };


// an Array literal
var ArrayLit = function(arr) {
  this.arr = arr;
  // DEP_LOG(" # " + this);
};
ArrayLit.prototype = Object.create(Dynamic);

ArrayLit.prototype.possibleValues = function() {
  if (this.arr.length == 0) return [[]];
  return expandPossibleValues(
    this.arr.map(function(val){
      return val.possibleValues();
    })
  );
};

ArrayLit.prototype.toString = function() {
  var join = function(vals) { return vals.join(","); };
  return "ArrayLit" + str(this.arr);
};

// an Object literal
var ObjectLit = function(spec, pctx) {
  var props = this.props = [];
  var scope = current_scope(pctx);

  for (var i=0; i<spec.length; ++i) {
    var def = spec[i];
    def[1] = new Id(def[1], scope);
    if (def[0] == "prop") {
      props.push([def[1], def[2]]);
    } else if (def[0] == "pat") {
      var value = def[1];
      var key = def[2];
      if (def.length == 3) {
        // shorthand "prop" for "prop:prop"
        key = def[1];
      }
      props.push([key, value]);
    }
  }
  DEP_LOG("GEN_OBJ_LIT: " + str(props));
  // DEP_LOG(" # " + this);
}
ObjectLit.prototype = Object.create(Dynamic);
ObjectLit.prototype.possibleValues = function() {
  var props = this.props;
  var rv = [];

  var valuePossibilities = expandPossibleValues(
      this.props.map(function(prop) { return prop[1].possibleValues(); }));

  for (var i=0; i<valuePossibilities.length; i++) {
    var possibilityValues = valuePossibilities[i];
    var obj = {};
    var empty = true;
    for (var propi=0; propi<this.props.length; propi++) {
      var key = props[propi][0];
      if (key instanceof Id) {
        key = key.name;
      } else {
        continue;
      }
      var v = possibilityValues[propi];
      if (v !== undefined) {
        obj[key] = v;
        empty = false;
      }
    }
    if(!empty) rv.push(obj);
  }
  return rv;
};

ObjectLit.prototype.toString = function() { return "ObjectLit(" + str(this.props) + ")"; };


function init_toplevel(pctx) {
  var GlobalScope = new Scope(null, pctx);
  var PredefinedModuleScope = new Scope(GlobalScope, pctx);
  var ModuleScope = new Scope(PredefinedModuleScope, pctx);

  function constant(name) {
    var v = PredefinedModuleScope.add_var(name);
    return v;
  };
  ModuleScope.top = ModuleScope;
  ModuleScope.require = constant('require');
  ModuleScope.module = constant('module');

  var export_expressions = [constant('exports'), ModuleScope.module.dot('exports')];

  // __oni_altns should be considered part of module scope, unlike
  // exports / module / require which sit above it
  ModuleScope.add_var('__oni_altns');

  ModuleScope.is_exports = function(expr) {
    return export_expressions.indexOf(expr) !== -1;
  };
  ModuleScope.determineModuleReferences = determineModuleReferences;
  pctx.scopes = [ModuleScope];
  pctx.current_stmt = new Statement();
  pctx.stmt_index = 0;
};

function push_scope(pctx, new_scope) {
  DEP_LOG("++ SCOPE");
  var parent = current_scope(pctx).scope;
  var scope;
  if (new_scope) { // TODO: use MultipleStatements block instead?
    scope = new Scope(parent, pctx);
    scope.top = pctx.scopes[0];
  } else {
    scope = Block(parent);
  }
  pctx.scopes.push(scope);
  return scope;
}

function pop_scope(pctx) {
  var scope = pctx.scopes.pop();
  scope.convert_unused_identifiers_into_references();
  DEP_LOG("-- SCOPE");
  return scope;
}

function add_stmt(stmt, pctx) {
  var scope = current_scope(pctx);
  var top = scope.top === scope;
  function _add_stmt(stmt) {
    if (!stmt) {
      return;
    }

    if (stmt instanceof MultipleStatements || BlockProto.isPrototypeOf(stmt)) {
      DEP_LOG("add_stmt expanding MultipleStatements: " + stmt);
      stmt = stmt.stmts;
    }

    if(Array.isArray(stmt)) {
      DEP_LOG("Adding " + stmt.length + " statements");
      for (var i=0;i<stmt.length;i++) {
        // NOTE: we give the same index to multiple toplevel assignments, because
        // they all come from the same statement (even though we track
        // them separately for dependency reasons)
        _add_stmt(stmt[i]);
      }
      return;
    }
    if (top) {
      DEP_LOG("TOPLEVEL STMT: " + stmt);
      var container = pctx.current_stmt;
      container.set(stmt);
      scope.convert_unused_identifiers_into_references();
      pctx.current_stmt = new Statement();
      var seen = [];

      function add_scope_from(stmt) {
        if (seen.indexOf(stmt) !== -1) {
          // recursive invocation
          return;
        }
        seen.push(stmt);
        if (stmt instanceof Assignment) {
          DEP_LOG("Assignment to: " + str(stmt.provides));
          for (var p = 0; p<stmt.provides.length; p++) {
            var provided = stmt.provides[p];
            var root = provided;
            DEP_LOG("root : " + root);
            var prop = null;
            if (root instanceof Property) {
              while(root instanceof Property) {
                if (scope.is_exports(root)) break; // don't progress up past exports
                prop = root.name;
                root = root.parent;
              }
            }
            if (scope.is_exports(root)) {
              applyScope(container, prop ? 'exports.' + prop : null);
            } else {
              add_scope_from(root);
            }
          }
        } else if (stmt instanceof Variable) {
          if (stmt.scope === scope) {
            // toplevel var: apply this scope
            applyScope(container, assert(stmt.name));
          }

          // also apply any scopes adopted by its values
          for (var vali=0; vali<stmt.values.length; vali++) {
            add_scope_from(stmt.values[vali]);
          }
        } else {
          return false;
        }
        return true;
      }
      var added = add_scope_from(stmt, true);
      if (!added) {
        // default to toplevel scope
        DEP_LOG("Non-assignment: " + stmt);
        applyScope(container, null);
      }

      stmt = container;

      if (stmt.exportScope === undefined) {
        // all toplevel statements have a global exportScope by default
        applyScope(stmt, null);
      }
    }
    stmt.index = pctx.stmt_index;
    scope.stmts.push(stmt);
  };
  _add_stmt.call(this, stmt);
};

function current_scope(pctx) {
  return pctx.scopes[pctx.scopes.length-1];
}



//----------------------------------------------------------------------
// misc:

  
//----------------------------------------------------------------------
// contexts:






// XXX should we distinguish fbody block from standard block, to e.g
// treat statements as toplevel even when they appea under if(hostenv === 'xbrowser') { ... }














//----------------------------------------------------------------------
// statements:
















function gen_crf(crf) {
  var rv = Dynamic;
  if (crf[2])
    rv = rv.seq(crf[2]);
  return rv;
}


//----------------------------------------------------------------------
// expressions:


// note the intentional space in ' =>' below; it is to fix cases like '= => ...'



























//----------------------------------------------------------------------
// Helpers

function Hash() {}
Hash.prototype = {
  lookup: function(key) { return this["$"+key]; },
  put: function(key, val) { this["$"+key] = val; },
  del: function(key) { delete this["$"+key]; }
};

//----------------------------------------------------------------------
// Tokenizer

// PAT_NBWS == \s+ without \n or \r
//define [ \f\t\v\u00A0\u2028\u2029]+ \\s+
// we ignore '//'-style comments as well as hashbangs (XXX not quite right)

// whitespace/comments with newlines
// doesn't work on IE: define PAT_COMMENT \/\*[^]*?\*\/







// symbols that can appear in an 'statement/argument position':
// symbols that can appear in an 'operator position':




// tokenizer for tokens in a statement/argument position:
var TOKENIZER_SA = /(?:[ \f\t\v\u00A0\u2028\u2029]+|\/\/.*|#!.*)*(?:((?:(?:\r\n|\n|\r)|\/\*(?:.|\n|\r)*?\*\/)+)|((?:0[xX][\da-fA-F]+)|(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?))|(\/(?:\\.|\[(?:\\[^\r\n]|[^\n\r\]])*\]|[^\[\/\r\n])+\/[gimy]*)|(==|!=|->|=>|>>|<<|<=|>=|--|\+\+|\|\||&&|\.\.|[-*\/%+&^|]=|[;,?:|^&=<>+\-*\/%!~.\[\]{}()\"`]|[$@_\w]+)|('(?:\\[^\r\n]|[^\\\'\r\n])*')|('(?:\\(?:(?:[^\r\n]|(?:\r\n|\n|\r)))|[^\\\'])*')|(\S+))/g;


// tokenizer for tokens in an operator position:
var TOKENIZER_OP = /(?:[ \f\t\v\u00A0\u2028\u2029]+|\/\/.*|#!.*)*(?:((?:(?:\r\n|\n|\r)|\/\*(?:.|\n|\r)*?\*\/)+)|(>>>=|===|!==|>>>|<<=|>>=|==|!=|->|=>|>>|<<|<=|>=|--|\+\+|\|\||&&|\.\.|[-*\/%+&^|]=|[;,?:|^&=<>+\-*\/%!~.\[\]{}()\"`]|[$@_\w]+))/g;


// tokenizer for tokens in an interpolating string position:
var TOKENIZER_IS = /((?:\\[^\r\n]|\#(?!\{)|[^#\\\"\r\n])+)|(\\(?:\r\n|\n|\r))|((?:\r\n|\n|\r))|(\"|\#\{)/g;

// tokenizer for tokens in an quasi-literal:
var TOKENIZER_QUASI = /((?:\\[^\r\n]|\$(?![\{a-zA-Z_$@])|[^$\\\`\r\n])+)|(\\(?:\r\n|\n|\r))|((?:\r\n|\n|\r))|(\`|\$\{|\$(?=[a-zA-Z_$@]))/g;

//----------------------------------------------------------------------
// Syntax Table

function SemanticToken() {}
SemanticToken.prototype = {
  //----------------------------------------------------------------------
  // parser 'api'

  // expression starter function
  exsf: function(pctx) { throw new Error("Unexpected '" + this + "'"); },
  // expression continuation binding power
  excbp: 0,

  // expression continuation
  excf: function(left, pctx) { throw new Error("Unexpected '" + this + "'"); },
  // statement function
  stmtf: null,

  // tokenizer for next token:
  tokenizer: TOKENIZER_SA,
  
  //----------------------------------------------------------------------
  // helpers
  
  toString: function() { return "'"+this.id+"'"; },

  //----------------------------------------------------------------------
  // semantic token construction 'api'
  
  exs: function(f) {
    this.exsf = f;
    return this;
  },
  exc: function(bp, f) {
    this.excbp = bp;
    if (f) this.excf = f;
    return this;
  },
  stmt: function(f) {
    this.stmtf = f;
    return this;
  },

  // encode infix operation
  ifx: function(bp, right_assoc) {
    this.excbp = bp;
    if (right_assoc) bp -= .5;
    this.excf = function(left, pctx) {
      var right = parseExp(pctx, bp);
      
      return right;
    };
    return this;
  },
  // encode assignment operation
  asg: function(bp, right_assoc) {
    this.excbp = bp;
    if (right_assoc) bp -= .5;
    this.excf = function(left, pctx) {
      var right = parseExp(pctx, bp);
      
      DEP_LOG("ASSIGN_OP", str(left), this.id, str(right));   return MultipleStatements.wrap(expand_assignment(false, left, this.id, right, pctx));
    };
    return this;
  },
  // encode prefix operation
  pre: function(bp) {
    return this.exs(function(pctx) {
      var right = parseExp(pctx, bp);
      
      return right;
    });
  },
  // encode postfix operation
  pst: function(bp) {
    return this.exc(bp, function(left, pctx) {
      
      return left;
    });
  }  
};

//-----
function Literal(type, value) {
  this.id = type;
  this.value = value;
}
Literal.prototype = new SemanticToken();
Literal.prototype.tokenizer = TOKENIZER_OP;
Literal.prototype.toString = function() { return "literal '"+this.value+"'"; };
Literal.prototype.exsf = function(pctx) {
  
  return new Lit(this.value);
};

//-----
function Identifier(value) {
  if (value.charAt(0) === '@') {
    this.alternate = true;
    this.id = "<@id>";
    this.value = value.substr(1);
  }
  else
    this.value = value;
}
Identifier.prototype = new Literal("<id>");
Identifier.prototype.exsf = function(pctx) {
  if (this.alternate === true) {
    if (this.value.length) {
      
      DEP_LOG("@NS IDENT"); return current_scope(pctx).get_var("__oni_altns").dot(this.value);
    }
    else {
      
      DEP_LOG("@NS plain"); return current_scope(pctx).get_var("__oni_altns");
    }
  }
  else {
    
    var ident = new Id(this.value, current_scope(pctx));   current_scope(pctx).add_ident(ident);             return ident;
  }
};

//-----
// base syntax table
var ST = new Hash();
function S(id, tokenizer) {
  var t = new SemanticToken();
  t.id = id;
  if (tokenizer)
    t.tokenizer = tokenizer;
  ST.put(id, t);
  return t;
}

/*
BP: Binding Power
P: Precedence
A: Associativity (L: left, R: right)
*: Designates an SJS-specific construct

BP  P  A    Operator      Operand Types                  Operation Performed
270  1 L     []           MemberExp Expression        
       L     .            MemberExp Identifier        
       R     new          MemberExp Arguments        
260  2 L     ( )          CallExpression Arguments       Function Call
       L     { }          CallExpression BlockArguments  Block Lambda Call
  (    L     []           CallExpression Expression        )
  (    L     .            CallExpression Identifier        )  
*255   L     ..           ArgExp CallExpression          Double Dot Call
250  3 n/a   ++           LeftHandSideExp                PostfixIncrement
       n/a   --           LeftHandSideExp                PostfixDecrement
240  4 R     delete       UnaryExp                       Call Delete Method
       R     void         UnaryExp                       Eval and Return undefined
       R     typeof       UnaryExp                       Return Type of an Object
  (    R     ++           UnaryExp                       PrefixIncrement )
  (    R     --           UnaryExp                       PrefixDecrement )
       R     +            UnaryExp                       UnaryPlus
       R     -            UnaryExp                       UnaryMinus
       R     ~            UnaryExp                       BitwiseNot
       R     !            UnaryExp                       LogicalNot
230  5 L     *            MultExp UnaryExp               Multiplication
       L     /            MultExp UnaryExp               Division
       L     %            MultExp UnaryExp               Remainder
220  6 L     +            AddExp MultExp                 Addition
       L     -            AddExp MultExp                 Subtraction
210  7 L     <<           ShiftExp AddExp                BitwiseLeftShift
       L     >>           ShiftExp AddExp                SignedRightShift
       L     >>>          ShiftExp AddExp                UnsignedRightShift
200  8 L     <            RelExp ShiftExp                LessThanComparison
       L     >            RelExp ShiftExp                GreaterThanComparison
       L     <=           RelExp ShiftExp                LessThanOrEqualComparison
       L     >=           RelExp ShiftExp                GreaterThanOrEqualComparison
       L     instanceof   RelExp ShiftExp                Call HasInstance Method
       L     in           RelExp ShiftExp                Call HasProperty Method
190 9  L     ==           EqualExp RelExp                IsEqual
       L     !=           EqualExp RelExp                IsNotEqual
       L     ===          EqualExp RelExp                IsStrictlyEqual
       L     !==          EqualExp RelExp                IsStrictlyNotEqual
180 10 L     &            BitwiseAndExp EqualExp         BitwiseAnd
170 11 L     ^            BitwiseXorExp EqualExp         Bitwise Xor
160 12 L     |            BitwiseOrExp EqualExp          BitwiseOr
150 13 L     &&           LogicalAndExp BitwiseOrExp     LogicalAnd
140 14 L     ||           LogicalOrExp LogicalAndExp     LogicalOr
130 15 R     ? :          LogicalOrExp AssignExp AssignExp   ConditionalExpression
120 16 R      =           LeftHandSideExp AssignExp      AssignmentExpression
       R     *=           LeftHandSideExp AssignExp      AssignmentWithMultiplication
       R     /=           LeftHandSideExp AssignExp      AssignmentWithDivision
       R     %=           LeftHandSideExp AssignExp      AssignmentWithRemainder
       R     +=           LeftHandSideExp AssignExp      AssignmentWithAddition
       R     -=           LeftHandSideExp AssignExp      AssignmentWithSubtraction
       R     <<=          LeftHandSideExp AssignExp      AssignmentWithBitwiseLeftShift
       R     >>=          LeftHandSideExp AssignExp      AssignmentWithSignedRightShift
       R     >>>=         LeftHandSideExp AssignExp      AssignmentWithUnsignedRightShift
       R     &=           LeftHandSideExp AssignExp      AssignmentWithBitwiseAnd
       R     ^=           LeftHandSideExp AssignExp      AssignmentWithBitwiseOr
       R     |=           LeftHandSideExp AssignExp      AssignmentWithLogicalNot
*      R     ->           Args AssignExp                 Thin Arrow 
*      R     ->           AssignExp                      Thin Arrow (prefix form)
*      R     =>           Args AssignExp                 Fat Arrow
*      R     =>           AssignExp                      Fat Arrow (prefix form)
*115         spawn        SpawnExp                       StratifiedJS 'spawn'
110 17 L     ,            Expression AssignExp           SequentialEvaluation

expressions up to BP 100

*/


S("[").
  // array literal
  exs(function(pctx) {
    var elements = [];
    while (pctx.token.id != "]") {
      if (elements.length) scan(pctx, ",");
      if (pctx.token.id == ",") {
        elements.push((function(pctx) {  return Dynamic; })(pctx));
      }
      else if (pctx.token.id == "]")
        break; // allows trailing ','
      else
        elements.push(parseExp(pctx, 110));
    }
    scan(pctx, "]");
    
    return new ArrayLit(elements);
  }).
  // indexed property access
  exc(270, function(l, pctx) {
    var idxexp = parseExp(pctx);
    scan(pctx, "]");
    
    return l.dot(idxexp);
  });

S(".").exc(270, function(l, pctx) {
  if (pctx.token.id != "<id>")
    throw new Error("Expected an identifier, found '"+pctx.token+"' instead");
  var name = pctx.token.value;
  scan(pctx);
  
  DEP_LOG("DOTTING:"+l + "." + name);return l.dot(name);
});

S("new").exs(function(pctx) {
  var exp = parseExp(pctx, 260);
  var args = [];
  if (pctx.token.id == "(") {
    scan(pctx); // swallow '('
    while (pctx.token.id != ")") {
      if (args.length) scan(pctx, ",");
      args.push(parseExp(pctx, 110));
    }
    scan(pctx, ")");
  }
  
  return Dynamic;
});

S("(").
  // grouping/parameter list
  exs(function (pctx) {
    if (pctx.token.id == ')') {
      // empty parameter list
      var op = scan(pctx, ')');
      if (op.id != '->' &&
          op.id != '=>')
        throw new Error("Was expecting '->' or '=>' after empty parameter list, but saw '"+pctx.token.id+"'");
      scan(pctx);
      return op.exsf(pctx);
    }
    var e = parseExp(pctx);
    scan(pctx, ")");
    
    return e;
  }).
  // function call
  exc(260, function(l, pctx) {
    var args = [];
    while (pctx.token.id != ")") {
      if (args.length) scan(pctx, ",");
      args.push(parseExp(pctx, 110)); // only parse up to comma
    }
    scan(pctx, ")");
    // special case for blocklambdas: pull the blocklambda into the argument list
    // f(a,b,c) {|..| ...} --> f(a,b,c,{|..| ...})
    if (pctx.token.id == '{') {
      // look ahead for '|' or '||'
      TOKENIZER_SA.lastIndex = pctx.lastIndex;
      while (1) {
        var matches = TOKENIZER_SA.exec(pctx.src);
        if (matches && 
            (matches[4] == '|' ||
             matches[4] == '||')) {
          // ok, we've got a blocklambda -> pull it in
          args.push(parseBlockLambda(scan(pctx).id, pctx));
        }
        else if (matches && matches[1]) {
          continue;
        }
        break;
      }
    }

    
    DEP_LOG("CALLING:" + str(l)); return l.call(args);
  });

S("..").exc(255, function(l, pctx) {
  var r = parseExp(pctx, 255);
  
  return l.seq(r);
});

S("++").pre(240).pst(250).asi_restricted = true;
S("--").pre(240).pst(250).asi_restricted = true;

S("delete").pre(240);
S("void").pre(240);
S("typeof").pre(240);
S("+").pre(240).ifx(220);
S("-").pre(240).ifx(220);
S("~").pre(240); 
S("!").pre(240);

S("*").ifx(230);
S("/").ifx(230);
S("%").ifx(230);

// +,-: see above

S("<<").ifx(210);
S(">>").ifx(210);
S(">>>").ifx(210);

S("<").ifx(200);
S(">").ifx(200);
S("<=").ifx(200);
S(">=").ifx(200);
S("instanceof").ifx(200);

S("in").ifx(200);

S("==").ifx(190);
S("!=").ifx(190);
S("===").ifx(190);
S("!==").ifx(190);

S("&").ifx(180);
S("^").ifx(170);
S("|").ifx(160);
S("&&").ifx(150);
S("||").ifx(140);

S("?").exc(130, function(test, pctx) {
  var consequent = parseExp(pctx, 110);
  if (pctx.token.id == ":") {
    scan(pctx, ":");
    var alternative = parseExp(pctx, 110);
  }
  
  return Dynamic;
});

S("=").asg(120, true);
S("*=").asg(120, true);
S("/=").asg(120, true);
S("%=").asg(120, true);
S("+=").asg(120, true);
S("-=").asg(120, true);
S("<<=").asg(120, true);
S(">>=").asg(120, true);
S(">>>=").asg(120, true);
S("&=").asg(120, true);
S("^=").asg(120, true);
S("|=").asg(120, true);

S("->")
  // prefix form without parameters expression
  .exs(function(pctx) {
    var body = parseExp(pctx, 119.5); // 119.5 because of right-associativity
    
    return Dynamic;
  })
  // infix form with parameters expression
  .exc(120, function(left, pctx) {
    var body = parseExp(pctx, 119.5);
    
    return Dynamic;
  });
S("=>")
  // prefix form without parameters expression
  .exs(function(pctx) {
    var body = parseExp(pctx, 119.5); // 119.5 because of right-associativity
    
    return Dynamic;
  })
  // infix form with parameters expression
  .exc(120, function(left, pctx) {
    var body = parseExp(pctx, 119.5);
    
    return Dynamic;
  });

S("spawn").pre(115);

S(",").ifx(110, true);

// helper to parse a token into a valid property name:
function parsePropertyName(token, pctx) {
  var id = token.id;
  if (id == "<@id>")
    return '@'+token.value;
  if (id == "<id>"
      || id == "<string>" || id == "<number>")
    return token.value;
  if (id == '"') {
    if ((token = scan(pctx)).id != "<string>" ||
        scan(pctx, undefined, TOKENIZER_IS).id != 'istr-"')
      throw new Error("Non-literal strings can't be used as property names ("+token+")");
    return '"'+token.value+'"';
  }
  throw new Error("Invalid object literal syntax; property name expected, but saw "+token);
}

function parseBlock(pctx) {
  
  push_scope(pctx, false);
  while (pctx.token.id != "}") {
    var stmt = parseStmt(pctx);
    
    add_stmt(stmt, pctx);
  }
  scan(pctx, "}");
  
  DEP_LOG("END_BLOCK: " + str(current_scope(pctx))); return pop_scope(pctx);
}

function parseBlockLambdaBody(pctx) {
  
  push_scope(pctx, true);
  while (pctx.token.id != "}") {
    var stmt = parseStmt(pctx);
    
    add_stmt(stmt, pctx);;
  }
  scan(pctx, "}");
  
  pop_scope(pctx); return Dynamic;
}
function parseBlockLambda(start, pctx) {
  // collect parameters
  var pars;
  if (start == '||') {
    pars = [];
    scan(pctx);
  } else {
    pars = parseFunctionParams(pctx, '|', '|');
  }

  var body = parseBlockLambdaBody(pctx);
  
  return Dynamic;
}

S("{").
  exs(function(pctx) {
    var start = pctx.token.id;
    if (start == "|" || start == "||") {
      // block lambda */
      return parseBlockLambda(start, pctx);
    }
    else {
      // object literal:
      var props = [];
      while (pctx.token.id != "}") {
        if (props.length) scan(pctx, ",");
        var prop = pctx.token;
        if (prop.id == "}")
          break; // allows trailing ','
        prop = parsePropertyName(prop, pctx);
        scan(pctx);
        if (pctx.token.id == ":") {
          // 'normal' property
          scan(pctx);
          var exp = parseExp(pctx, 110); // only parse up to comma
          props.push(["prop",prop,exp]);
        }
        else if (pctx.token.id == "}" || pctx.token.id == ",") {
          if (prop.charAt(0) == "'" || prop.charAt(0) == '"')
            throw new Error("Quoted identifiers not allowed in destructuring patterns ("+prop+")");
          props.push(["pat", prop, pctx.line]);
        }
        else
          throw new Error("Unexpected token '"+pctx.token+"'");
      }
      scan(pctx, "}", TOKENIZER_OP); // note the special tokenizer case here
      
      return new ObjectLit(props, pctx);
    }
  }).
  // block lambda call:
  exc(260, function(l, pctx) {
    var start = pctx.token.id;
    if (start != "|" && start != "||")
      throw new Error("Unexpected token '"+pctx.token+"' - was expecting '|' or '||'");
    var args = [parseBlockLambda(start, pctx)];
    
    DEP_LOG("CALLING:" + str(l)); return l.call(args);;
  }).
  // block:
  stmt(parseBlock);

// deliminators
S(";").stmt(function(pctx) {  return Dynamic; });
S(")", TOKENIZER_OP);
S("]", TOKENIZER_OP);
S("}"); // note the special tokenizer case for object literals, above
S(":");

S("<eof>").
  exs(function(pctx) { throw new Error("Unexpected end of input (exs)"); }).
  stmt(function(pctx) { throw new Error("Unexpected end of input (stmt)"); });

// statements/misc

// helper to parse a function body:
function parseFunctionBody(pctx, implicit_return) {
  
  push_scope(pctx, true);
  scan(pctx, "{");
  while (pctx.token.id != "}") {
    var stmt = parseStmt(pctx);
    
    add_stmt(stmt, pctx);
  }
  scan(pctx, "}");
  
  DEP_LOG("END_FBODY: " + str(current_scope(pctx))); pop_scope(pctx); return Dynamic;
}

function parseFunctionParam(pctx) {
  var t = pctx.token;
  scan(pctx);
  var left = t.exsf(pctx);
  while (pctx.token.id != '|' && pctx.token.excbp > 110) {
    t = pctx.token;
    scan(pctx);
    left = t.excf(left, pctx);
  }
  return left;
}

function parseFunctionParams(pctx, starttok, endtok) {
  if (!starttok) { starttok = '('; endtok = ')'; }
  var pars = [];
  scan(pctx, starttok);
  while (pctx.token.id != endtok) {
    if (pars.length)
      scan(pctx, ",");
    switch(pctx.token.id) {
      case "{":
      case "[":
        pars.push(parseFunctionParam(pctx));
        break;
      case "<id>":
        pars.push(pctx.token.exsf(pctx));
        scan(pctx);
        break;
      default:
        throw new Error("Expected function parameter but found '"+pctx.token+"'");
    }
    token = pctx.token;
  }
  scan(pctx, endtok);
  return pars;
}


S("function").
  // expression function form ('function expression')
  exs(function(pctx) {
    var fname = "";
    if (pctx.token.id == "<id>") {
      fname = pctx.token.value;
      scan(pctx);
    }
    var pars = parseFunctionParams(pctx);
    var body = parseFunctionBody(pctx);
    
    DEP_LOG("FUNBOD: " + str(body)); return body;
  }).
  // statement function form ('function declaration')
  stmt(function(pctx) {
    if (pctx.token.id != "<id>") throw new Error("Malformed function declaration");
    var fname = pctx.token.value;
    scan(pctx);
    var pars = parseFunctionParams(pctx);
    var body = parseFunctionBody(pctx);
    
    var v = current_scope(pctx).add_var(fname);   return new Assignment(v, '=', body, pctx);
  });

S("this", TOKENIZER_OP).exs(function(pctx) {  return current_scope(pctx).get_var("this"); });
S("true", TOKENIZER_OP).exs(function(pctx) {  return new Lit("true"); });
S("false", TOKENIZER_OP).exs(function(pctx) {  return new Lit("false"); });
S("null", TOKENIZER_OP).exs(function(pctx) {  return new Lit("null"); });

S("collapse", TOKENIZER_OP).exs(function(pctx) {  /* */ });

S('"', TOKENIZER_IS).exs(function(pctx) {
  var parts = [], last=-1;
  while (pctx.token.id != 'istr-"') {
    switch (pctx.token.id) {
    case "<string>":
      // XXX not sure this retrospective collecting of adjacent
      // strings makes sense here; maybe this should be built into the
      // tokenization. (The problem is that the tokenizer splits
      // strings on '\n')
      if (last!=-1 && typeof parts[last] == 'string') {
        parts[last] += pctx.token.value;
      }
      else {
        parts.push(pctx.token.value);
        ++last;
      }
      break;
    case 'istr-#{':
      scan(pctx);
      // we push an array to distinguish from strings:
      // (the kernel might generate a string for 'parseExp', which would leave
      // no way to distinguish between expressions and literal parts of the string
      // in GEN_INTERPOLATING_STR).
      parts.push([parseExp(pctx)]); 
      ++last;
      break;
    case "<eof>":
      throw new Error("Unterminated string");
      break;
    default:
      throw new Error("Internal parser error: Unknown token in string ("+pctx.token+")");
    }
    scan(pctx, undefined, TOKENIZER_IS);
  }
  scan(pctx);

  if (last == -1) {
    parts.push('');
    last = 0;
  }

  if (last == 0 && typeof parts[0] == 'string') {
    var val = '"'+parts[0]+'"';
    return new Lit(val);
  }
  return Dynamic;
});

S('istr-#{', TOKENIZER_SA);
S('istr-"', TOKENIZER_OP);

S('`', TOKENIZER_QUASI).exs(function(pctx) {
  var parts = [], current=0;
  while (pctx.token.id != 'quasi-`') {
    switch (pctx.token.id) {
    case '<string>':
      // strings always go into an even position. If we get a string
      // with current=odd it means the tokenizer gave us two adjacent
      // strings (can happen because the tokenizer splits strings on
      // '\n'). In this case we append the new string to the last string:
      if (current % 2)
        parts[current-1] += pctx.token.value;
      else {
        parts.push(pctx.token.value);
        ++current;
      }
      break;
    case 'quasi-${':
      scan(pctx);
      // expressions always go into an odd position. If we're in an even
      // position we insert an empty string:
      if ((current % 2) == 0) {
        parts.push('');
        ++current;
      }
      parts.push(parseExp(pctx));
      ++current;
      break;
    case 'quasi-$':
      // expressions always go into an odd position. If we're in an even
      // position we insert an empty string:
      if ((current % 2) == 0) {
        parts.push('');
        ++current;
      }
      parts.push(parseQuasiInlineEscape(pctx));
      ++current;
      break;

    case '<eof>':
      throw new Error('Unterminated string');
      break;
    default:
      throw new Error('Internal parser error: Unknown token in string ('+pctx.token+')');
    }
    scan(pctx, undefined, TOKENIZER_QUASI);
  }
  scan(pctx);
  
  // xxx can this happen?
  if (current == 0) {
    parts.push('');
  }

  return Dynamic;;
});

function parseQuasiInlineEscape(pctx) {
  // scan an identifier:
  var identifier = scan(pctx);
  if (pctx.token.id !== "<id>" && pctx.token.id !== "<@id>") throw new Error("Unexpected " + pctx.token + " in quasi template");
  if (pctx.src.charAt(pctx.lastIndex) != '(') {
    // $variable
    return identifier.exsf(pctx);
  }
  else {
    scan(pctx); // consume identifier
    scan(pctx, '('); // consume '('
    // $func(args)
    var args = [];
    while (pctx.token.id != ')') {
      if (args.length) scan(pctx, ',');
      args.push(parseExp(pctx, 110)); // only parse up to comma
    }
    DEP_LOG("CALLING:" + str(identifier.exsf(pctx))); return identifier.exsf(pctx).call(args);
  }
}

S('quasi-${', TOKENIZER_SA);
S('quasi-$', TOKENIZER_SA);
S('quasi-`', TOKENIZER_OP);

function isStmtTermination(token) {
  return token.id == ";" || token.id == "}" || token.id == "<eof>";
}

function parseStmtTermination(pctx) {
  if (pctx.token.id != "}" && pctx.token.id != "<eof>" && !pctx.newline)
    scan(pctx, ";");
}

function parseVarDecls(pctx, noIn) {
  var decls = [];
  var parse = noIn ? parseExpNoIn : parseExp;
  do {
    if (decls.length) scan(pctx, ",");
    var id_or_pattern = parse(pctx, 120);
    if (pctx.token.id == "=") {
      scan(pctx);
      var initialiser = parse(pctx, 110);
      decls.push([id_or_pattern, initialiser]);
    }
    else
      decls.push([id_or_pattern]);
  } while (pctx.token.id == ",");
  return decls;
}
    
S("var").stmt(function(pctx) {
  var decls = parseVarDecls(pctx);
  parseStmtTermination(pctx);
  
  var stmts=[];                                                            for (var i=0; i<decls.length; ++i) {                                       DEP_LOG("GEN_VAR " + str(decls[i][0]));                              current_scope(pctx).add_var(decls[i][0]);                                expand_assignment(true, decls[i][0], '=', decls[i][1], pctx, stmts);   };                                                                       return MultipleStatements.wrap(stmts);
});

S("else");

S("if").stmt(function(pctx) {
  scan(pctx, "(");
  var test = parseExp(pctx);
  scan(pctx, ")");
  var consequent = parseStmt(pctx);
  var alternative = null;
  if (pctx.token.id == "else") {
    scan(pctx);
    alternative = parseStmt(pctx);
  }
  
  var stmts = [];                                     if (consequent instanceof Block) {                    stmts = stmts.concat(consequent.scope.stmts);     } else {                                              stmts.push(consequent);                           }                                                   if (alternative instanceof Block) {                   stmts = stmts.concat(alternative.scope.stmts)     } else {                                              stmts.push(alternative);                          }                                                   DEP_LOG("GEN_IF:" + str(stmts));           return MultipleStatements.wrap(stmts);
});

S("while").stmt(function(pctx) {
  scan(pctx, "(");
  var test = parseExp(pctx);
  scan(pctx, ")");
  /* */
  var body = parseStmt(pctx);
  /* */
  
  return Dynamic;
});

S("do").stmt(function(pctx) {
  /* */
  var body = parseStmt(pctx);
  /* */
  scan(pctx, "while");
  scan(pctx, "(");
  var test = parseExp(pctx);
  scan(pctx, ")");
  parseStmtTermination(pctx);
  
  return Dynamic;
});

S("for").stmt(function(pctx) {
  scan(pctx, "(");
  var start_exp = null;
  var decls = null;
  if (pctx.token.id == "var") {
    scan(pctx); // consume 'var'
    decls = parseVarDecls(pctx, true);
  }
  else {
    if (pctx.token.id != ';')
      start_exp = parseExpNoIn(pctx);
  }

  if (pctx.token.id == ";") {
    scan(pctx);
    var test_exp = null;
    if (pctx.token.id != ";")
      test_exp = parseExp(pctx);
    scan(pctx, ";");
    var inc_exp = null;
    if (pctx.token.id != ")")
      inc_exp = parseExp(pctx);
    scan(pctx, ")");
    /* */
    var body = parseStmt(pctx);
    /* */
    
    return Dynamic;
  }
  else if (pctx.token.id == "in") {
    scan(pctx);
    //XXX check that start_exp is a valid LHS
    if (decls && decls.length > 1)
      throw new Error("More than one variable declaration in for-in loop");
    var obj_exp = parseExp(pctx);
    scan(pctx, ")");
    /* */
    var body = parseStmt(pctx);
    /* */
    var decl = decls ? decls[0] : null;
    
    return Dynamic;
  }
  else
    throw new Error("Unexpected token '"+pctx.token+"' in for-statement");
});

S("continue").stmt(function(pctx) {
  var label = null;
  if (pctx.token.id == "<id>" && !pctx.newline) {
    label = pctx.token.value;
    scan(pctx);
  }
  parseStmtTermination(pctx);
  
  return Dynamic;
});

S("break").stmt(function(pctx) {
  var label = null;
  if (pctx.token.id == "<id>" && !pctx.newline) {
    label = pctx.token.value;
    scan(pctx);
  }
  parseStmtTermination(pctx);
  
  return Dynamic;
});

S("return").stmt(function(pctx) {
  var exp = null;
  if (!isStmtTermination(pctx.token) && !pctx.newline)
    exp = parseExp(pctx);
  parseStmtTermination(pctx);
  
  return exp;
});

S("with").stmt(function(pctx) {
  scan(pctx, "(");
  var exp = parseExp(pctx);
  scan(pctx, ")");
  var body = parseStmt(pctx);
  
  return body;
});

S("case");
S("default");

S("switch").stmt(function(pctx) {
  scan(pctx, "(");
  var exp = parseExp(pctx);
  scan(pctx, ")");
  scan(pctx, "{");
  /* */
  var clauses = [];
  while (pctx.token.id != "}") {
    var clause_exp = null;
    if (pctx.token.id == "case") {
      scan(pctx);
      clause_exp = parseExp(pctx);
    }
    else if (pctx.token.id == "default") {
      scan(pctx);
    }
    else
      throw new Error("Invalid token '"+pctx.token+"' in switch statement");
    scan(pctx, ":");
    
    /* */
    while (pctx.token.id != "case" && pctx.token.id != "default" && pctx.token.id != "}") {
      var stmt = parseStmt(pctx);
      
      /* */
    }
    clauses.push((function(pctx) {  /* */ })(pctx));
  }
  /* */
  scan(pctx, "}");
  
  return Dynamic;
});

S("throw").stmt(function(pctx) {
  if (pctx.newline) throw new Error("Illegal newline after throw");
  var exp = parseExp(pctx);
  parseStmtTermination(pctx);
  
  return Dynamic;;
});

S("catch");
S("finally");

// parse catch-retract-finally
// returns [ [catch_id,catch_block,catchall?]|null,
//           retract|null,
//           finally|null ]
function parseCRF(pctx) {
  var rv = [];
  var a = null;
  if (pctx.token.id == "catch"
      // XXX catchall should only work for try, not for waitfor!
      || pctx.token.value == "catchall" // XXX maybe use a real syntax token
     ) {
    var all = pctx.token.value == "catchall";
    a = [];
    scan(pctx);
    a.push(scan(pctx, "(").value);
    scan(pctx, "<id>");
    scan(pctx, ")");
    scan(pctx, "{");
    a.push(parseBlock(pctx));
    a.push(all);
  }
  rv.push(a);
  if (pctx.token.value == "retract") { // XXX maybe use a real syntax token
    scan(pctx);
    scan(pctx, "{");
    rv.push(parseBlock(pctx));
  }
  else
    rv.push(null);
  if (pctx.token.id == "finally") {
    scan(pctx);
    scan(pctx, "{");
    rv.push(parseBlock(pctx));
  }
  else
    rv.push(null);
  return rv;
}

S("try").stmt(function(pctx) {
  scan(pctx, "{");
  var block = parseBlock(pctx);
  var op = pctx.token.value; // XXX maybe use proper syntax token
  if (op != "and" && op != "or") {
    // conventional 'try'
    var crf = parseCRF(pctx);
    if (!crf[0] && !crf[1] && !crf[2])
      throw new Error("Missing 'catch', 'finally' or 'retract' after 'try'");
    
    return block.seq(gen_crf(pctx));
  }
  else {
    var blocks = [block];
    do {
      scan(pctx);
      scan(pctx, "{");
      blocks.push(parseBlock(pctx));
    } while (pctx.token.value == op);
    var crf = parseCRF(pctx);
    
    var rv = Dynamic;                                 for (var i=0; i<blocks.length; ++i){                rv = rv.seq(blocks[i]);                         }                                                 return rv;
  }
});

S("waitfor").stmt(function(pctx) {
  if (pctx.token.id == "{") {
    // DEPRECATED and/or forms
    scan(pctx, "{");
    var blocks = [parseBlock(pctx)];
    var op = pctx.token.value; // XXX maybe use syntax token
    if (op != "and" && op != "or") throw new Error("Missing 'and' or 'or' after 'waitfor' block");
    do {
      scan(pctx);
      scan(pctx, "{");
      blocks.push(parseBlock(pctx));
    } while (pctx.token.value == op);
    var crf = parseCRF(pctx);
    
    var rv = Dynamic;                                 for (var i=0; i<blocks.length; ++i){                rv = rv.seq(blocks[i]);                         }                                                 return rv;
  }
  else {
    // suspend form
    scan(pctx, "(");
    var has_var = (pctx.token.id == "var");
    if (has_var) scan(pctx);
    var decls = [];
    if (pctx.token.id == ")") {
      if (has_var) throw new Error("Missing variables in waitfor(var)");
    }
    else
      decls = parseVarDecls(pctx);
    scan(pctx, ")");
    scan(pctx, "{");
    
    /*nothing*/
    var block = parseBlock(pctx);
    var crf = parseCRF(pctx);
    
    /*nothing*/
    
    return block;
  }    
});


S("using").stmt(function(pctx) {
  var has_var;
  scan(pctx, "(");
  if (has_var = (pctx.token.id == "var"))
    scan(pctx);
  var lhs, exp;
  var e1 = parseExp(pctx, 120); // parse expression up to '=' at most
  if (pctx.token.id == "=") {
    lhs = e1; // need to check in kernel that lhs is a variable!
    scan(pctx);
    exp = parseExp(pctx);
  }
  else {
    if (has_var)
      throw new Error("Syntax error in 'using' expression");
    exp = e1;
  }
  scan(pctx, ")");
  var body = parseStmt(pctx);
  
  return body;
});

S("__js").stmt(function(pctx) {
  
  DEP_LOG("START JS BLOCK");
  var body = parseStmt(pctx);
  
  DEP_LOG("END_JS");
  
  return body;
});


// reserved keywords:
S("abstract");
S("boolean");
S("byte");
S("char");
S("class");
S("const");
S("debugger");
S("double");
S("enum");
S("export");
S("extends");
S("final");
S("float");
S("goto");
S("implements");
S("import");
S("int");
S("interface");
S("long");
S("native");
S("package");
S("private");
S("protected");
S("public");
S("short");
S("static");
S("super");
S("synchronized");
S("throws");
S("transient");
S("volatile");

//----------------------------------------------------------------------
// Parser

function makeParserContext(src, settings) {
  var ctx = {
    src       : src,
    line      : 1,
    lastIndex : 0,
    token     : null
  };

  if (settings)
    for (var a in settings)
      ctx[a] = settings[a];

  return ctx;
}


function compile(src, settings) {
  // XXX The regexps of our lexer currently assume that there is never
  // a '//' comment on the last line of the source text. This will
  // currently match as separate /'s, since we're not checking for
  // '$'.  We could amend our regexps and amend the check for EOF
  // below in the scan function, or we can ensure there's always a
  // '\n' at the end. Doing the latter for now, since I suspect it
  // wins performance-wise:

  var pctx = makeParserContext(src+"\n", settings);
  try {
    return parseScript(pctx);
  }
  catch (e) {
    var mes = e.mes || e;
    mes += "\n"+e.stack;
    var line = e.line || pctx.line;
    var exception = new Error("SJS syntax error "+(pctx.filename?"in "+pctx.filename+",": "at") +" line " + line + ": " + mes);
    exception.compileError = {message: mes, line: line};
    throw exception;
  }
}
exports.compile = compile;

function parseScript(pctx) {
  if (typeof pctx.scopes !== 'undefined')                        throw new Error("Internal parser error: Nested script");   pctx.export_scopes = {};                                     init_toplevel(pctx);
  scan(pctx);
  while (pctx.token.id != "<eof>") {
    var stmt = parseStmt(pctx);
    
    add_stmt(stmt, pctx); pctx.stmt_index++;;
  }
  return process_script(pctx);
}

function parseStmt(pctx) {
  var t = pctx.token;
  scan(pctx);
  if (t.stmtf) {
    // a specialized statement construct
    return t.stmtf(pctx);
  }
  else if (t.id == "<id>" && pctx.token.id == ":") {
    // a labelled statement
    scan(pctx); // consume ':'
    // XXX should maybe code this in non-recursive style:
    var stmt = parseStmt(pctx);
    
    return stmt;
  }
  else {
    // an expression statement
    var exp = parseExp(pctx, 0, t);
    parseStmtTermination(pctx);
    
    return exp;
  }
}

// bp: binding power of enclosing exp, t: optional next token 
function parseExp(pctx, bp, t) {
  bp = bp || 0;
  if (!t) {
    t = pctx.token;
    scan(pctx);
  }
  var left = t.exsf(pctx);
  while (bp < pctx.token.excbp) {
    t = pctx.token;
    // automatic semicolon insertion:
    if (pctx.newline && t.asi_restricted)
      return left;
    scan(pctx);
    left = t.excf(left, pctx);
  }
  return left;
}

// parse up to keyword 'in' ( where bp might be < bp(in) )
function parseExpNoIn(pctx, bp, t) {
  bp = bp || 0;
  if (!t) {
    t = pctx.token;
    scan(pctx);
  }
  var left = t.exsf(pctx);
  while (bp < pctx.token.excbp && pctx.token.id != 'in') {
    t = pctx.token;
    // automatic semicolon insertion:
    if (pctx.newline && t.asi_restricted)
      return left;
    scan(pctx);
    left = t.excf(left, pctx);
  }
  return left;
}


function scan(pctx, id, tokenizer) {
  if (!tokenizer) {
    if (pctx.token)
      tokenizer = pctx.token.tokenizer;
    else
      tokenizer = TOKENIZER_SA;
  }
  
  if (id && (!pctx.token || pctx.token.id != id))
    throw new Error("Unexpected " + pctx.token);
  pctx.token = null;
  pctx.newline = 0;
  while (!pctx.token) {
    tokenizer.lastIndex = pctx.lastIndex;
    var matches = tokenizer.exec(pctx.src);
    if (!matches) {
      pctx.token = ST.lookup("<eof>");
      break;
    }
    pctx.lastIndex = tokenizer.lastIndex;

    if (tokenizer == TOKENIZER_SA) {
      if (matches[4]) {
        pctx.token = ST.lookup(matches[4]);
        if (!pctx.token) {
          pctx.token = new Identifier(matches[4]);
        }
      }
      else if (matches[1]) {
        var m = matches[1].match(/(?:\r\n|\n|\r)/g);
        if (m) {
          pctx.line += m.length;
          pctx.newline += m.length;
          /* */
        }
        // go round loop again
      }
      else if (matches[5])
        pctx.token = new Literal("<string>", matches[5]);
      else if (matches[6]) {
        var val = matches[6];
        var m = val.match(/(?:\r\n|\n|\r)/g);
        pctx.line += m.length;
        pctx.newline += m.length;
        val = val.replace(/\\(?:\r\n|\n|\r)/g, "").replace(/(?:\r\n|\n|\r)/g, "\\n");
        pctx.token = new Literal("<string>", val);
      }
      else if (matches[2])
        pctx.token = new Literal("<number>", matches[2]);
      else if (matches[3])
        pctx.token = new Literal("<regex>", matches[3]);
      else if (matches[7])
        throw new Error("Unexpected characters: '"+matches[7]+"'");
      else
        throw new Error("Internal scanner error");
      //print("sa:"+pctx.token);
    }
    else if (tokenizer == TOKENIZER_OP) { // tokenizer == TOKENIZER_OP
      if (matches[2]) {
        pctx.token = ST.lookup(matches[2]);
        if (!pctx.token) {
          pctx.token = new Identifier(matches[2]);
        }
      }
      else if (matches[1]) {
        var m = matches[1].match(/(?:\r\n|\n|\r)/g);
        if (m) {
          pctx.line += m.length;
          pctx.newline += m.length;
          /* */
        }
        // go round loop again
      }
      else {
        // We might be in an SA position after an omitted
        // newline. switch tokenizers and try again. The SA tokenizer will
        // bail if it can't match a token either.
        tokenizer = TOKENIZER_SA;
        // go round loop again
      }
      //print("op:"+pctx.token);
    }
    else if (tokenizer == TOKENIZER_IS) { 
      // interpolating string tokenizer
      if (matches[1])
        pctx.token = new Literal("<string>", matches[1]);
      else if (matches[2]) {
        ++pctx.line;
        ++pctx.newline;
        // go round loop again
      }
      else if (matches[3]) {
        ++pctx.line;
        ++pctx.newline;
        pctx.token = new Literal("<string>", '\\n');
      }
      else if (matches[4]) {
        pctx.token = ST.lookup("istr-"+matches[4]);
      }
    }
    else if (tokenizer == TOKENIZER_QUASI) {
      // quasiliteral tokenizer
      if (matches[1])
        pctx.token = new Literal("<string>", matches[1]);
      else if (matches[2]) {
        ++pctx.line;
        ++pctx.newline;
        // go round loop again
      }
      else if (matches[3]) {
        ++pctx.line;
        ++pctx.newline;
        pctx.token = new Literal("<string>", '\\n');
      }
      else if (matches[4]) {
        pctx.token = ST.lookup("quasi-"+matches[4]);
      }
    }
    else
      throw new Error("Internal scanner error: no tokenizer");
  }
  return pctx.token;
}
