









// #define "STRINGIFY" for stringification

//----------------------------------------------------------------------
// helpers:

function push_scope(pctx) {
  pctx.scopes.push({stmts:[]});
  top_scope(pctx).stmts.push(flush_newlines(pctx));
}
function pop_scope(pctx) {
  return pctx.scopes.pop();
}
function top_scope(pctx) {
  return pctx.scopes[pctx.scopes.length-1];
}

//----------------------------------------------------------------------
// misc:

// XXX our newline handling is really quite hackish :-(
// XXX and it's completely broken by multiline strings atm :-(

function add_newlines(n,pctx) {
  if (!pctx.keeplines) return;
  if (typeof pctx.nls == 'undefined') pctx.nls = "";
  while (n--) pctx.nls += "\\n";
}

function flush_newlines(pctx) {
  if (!pctx.nls) return "";
  var rv = pctx.nls;
  pctx.nls = "";
  return rv;
}
  
//----------------------------------------------------------------------
// contexts:






function gen_block(code) {
  if (code.length && code[code.length-1]==";")
    code = code.substr(0,code.length-1);
  return "{"+code+"}";
}















//----------------------------------------------------------------------
// statements:



function gen_fun_pars(pars) {
  return pars.join(",");
}














function gen_crf(crf) {
  var rv = "";
  if (crf[0])
    rv += (crf[0][2] ? "catchall(" : "catch(")+crf[0][0]+")"+crf[0][1];
  if (crf[1])
    rv += "retract"+crf[1];
  if (crf[2])
    rv += "finally"+crf[2];
  return rv;
}


//----------------------------------------------------------------------
// expressions:


function gen_infix_op(left, id, right, pctx) {
  if (id == "instanceof" || id == "in" ||
      (id[0] == left[left.length-1]) || // e.g. left= "a--", id="-"
      (id[id.length-1] == right[0])) // e.g. id="+", right="++a"
    return left+" "+id+" "+right;
  else
    return left+id+right;
}



function gen_prefix_op(id, right, pctx) {
  if (id.length > 2 || // one of [delete,void,typeof,spawn]
      id[0]==right[0] && (id[0] == "+" || id[0] == "-")) // cases like "- --i"
    return id + " " + right;
  else
    return id+right;
}


// note the intentional space in ' =>' below; it is to fix cases like '= => ...'



function interpolating_string(parts) {
  var rv = '\\"';
  for (var i=0,l=parts.length;i<l;++i) {
    var p = parts[i];
    if (Array.isArray(p)) {
      p = "#{"+p[0]+"}";
    }
    else {
      p = p.replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"');
    }
    rv += p;
  }
  return rv+'\\"';
}

function quasi(parts) {
  var rv = '`';
  for (var i=0,l=parts.length;i<l;++i) {
    if (i % 2)
      rv += '#{'+parts[i]+'}';
    else {
      rv += parts[i].replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"');
    }
  }
  return rv + '`';
}


















// Stratified constructs:









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

// PAT_NBWS == \s+ without \n
//#define [ \f\r\t\v\u00A0\u2028\u2029]+ \\s+
// we ignore '//'-style comments as well as hashbangs (XXX not quite right)

// whitespace/comments with newlines
// doesn't work on IE: #define PAT_COMMENT \/\*[^]*?\*\/





// XXX unicode
// symbols that can appear in an 'statement/argument position':
// symbols that can appear in an 'operator position':




// tokenizer for tokens in a statement/argument position:
var TOKENIZER_SA = /(?:[ \f\r\t\v\u00A0\u2028\u2029]+|\/\/.*|#!.*)*(?:((?:\n|\/\*(?:.|\n|\r)*?\*\/)+)|((?:0[xX][\da-fA-F]+)|(?:(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?))|(\/(?:\\.|\[(?:\\.|[^\n\]])*\]|[^\[\/\n])+\/[gimy]*)|(==|!=|->|=>|>>|<<|<=|>=|--|\+\+|\|\||&&|\.\.|[-*\/%+&^|]=|[;,?:|^&=<>+\-*\/%!~.\[\]{}()\"`]|[$_\w]+)|('(?:\\.|[^\\\'\n])*')|('(?:\\(?:.|\n|\r)|[^\\\'])*')|(\S+))/g;


// tokenizer for tokens in an operator position:
var TOKENIZER_OP = /(?:[ \f\r\t\v\u00A0\u2028\u2029]+|\/\/.*|#!.*)*(?:((?:\n|\/\*(?:.|\n|\r)*?\*\/)+)|(>>>=|===|!==|>>>|<<=|>>=|==|!=|->|=>|>>|<<|<=|>=|--|\+\+|\|\||&&|\.\.|[-*\/%+&^|]=|[;,?:|^&=<>+\-*\/%!~.\[\]{}()\"`]|[$_\w]+))/g;


// tokenizer for tokens in an interpolating string position:
var TOKENIZER_IS = /((?:\\.|\#(?!\{)|[^#\\\"\n])+)|(\\\n)|(\n)|(\"|\#\{)/g;

// tokenizer for tokens in an quasi-literal:
var TOKENIZER_QUASI = /((?:\\.|\$(?![\{a-zA-Z_$])|[^$\\\`\n])+)|(\\\n)|(\n)|(\`|\$\{|\$(?=[a-zA-Z_$]))/g;

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
      
      return gen_infix_op(left,  this.id,  right,  pctx);
    };
    return this;
  },
  // encode assignment operation
  asg: function(bp, right_assoc) {
    this.excbp = bp;
    if (right_assoc) bp -= .5;
    this.excf = function(left, pctx) {
      var right = parseExp(pctx, bp);
      
      return left+ this.id+ right;
    };
    return this;
  },
  // encode prefix operation
  pre: function(bp) {
    return this.exs(function(pctx) {
      var right = parseExp(pctx, bp);
      
      return gen_prefix_op(this.id,  right,  pctx);
    });
  },
  // encode postfix operation
  pst: function(bp) {
    return this.exc(bp, function(left, pctx) {
      
      return left +  this.id + " ";
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
  
  if (this.id == "<string>")                                                    this.value =  this.value.replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"');   else if (this.id == "<regex>")                                                this.value =  this.value.replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"');   return  this.value;
};

//-----
function Identifier(value) {
  this.value = value;
}
Identifier.prototype = new Literal("<id>");
Identifier.prototype.exsf = function(pctx) {
  
  return this.value;
};
Identifier.prototype.toString = function() { return "identifier '"+this.value+"'";};

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




S("[").
  // array literal
  exs(function(pctx) {
    var elements = [];
    while (pctx.token.id != "]") {
      if (elements.length) scan(pctx, ",");
      if (pctx.token.id == ",") {
        elements.push((function(pctx) {  return " "; })(pctx));
      }
      else if (pctx.token.id == "]")
        break; // allows trailing ','
      else
        elements.push(parseExp(pctx, 110));
    }
    scan(pctx, "]");
    
    return "["+elements.join(",")+"]";
  }).
  // indexed property access
  exc(270, function(l, pctx) {
    var idxexp = parseExp(pctx);
    scan(pctx, "]");
    
    return l+"["+ idxexp+"]";
  });

S(".").exc(270, function(l, pctx) {
  if (pctx.token.id != "<id>")
    throw new Error("Expected an identifier, found '"+pctx.token+"' instead");
  var name = pctx.token.value;
  scan(pctx);
  
  return l+"."+ name;
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
  
  return "new "+exp+"("+ args.join(",")+")";
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
    
    return "("+e+")";
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

    
    return l+"("+ args.join(",")+")";
  });

S("..").exc(255, function(l, pctx) {
  var r = parseExp(pctx, 255);
  
  return l+".."+r;
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
  scan(pctx, ":");
  var alternative = parseExp(pctx, 110);
  
  return test+"?"+ consequent+":"+ alternative;
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
    
    return gen_prefix_op('->',  body,  pctx);
  })
  // infix form with parameters expression
  .exc(120, function(left, pctx) {
    var body = parseExp(pctx, 119.5);
    
    return gen_infix_op(left,  '->',   body,   pctx);
  });
S("=>")
  // prefix form without parameters expression
  .exs(function(pctx) {
    var body = parseExp(pctx, 119.5); // 119.5 because of right-associativity
    
    return gen_prefix_op(' =>',  body,  pctx);
  })
  // infix form with parameters expression
  .exc(120, function(left, pctx) {
    var body = parseExp(pctx, 119.5);
    
    return gen_infix_op(left,  '=>',   body,   pctx);
  });

S("spawn").pre(115);

S(",").ifx(110, true);

// helper to parse a token into a valid property name:
function parsePropertyName(token, pctx) {
  var id = token.id;
  if (id == "<id>" || id == "<string>" || id == "<number>")
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
  
  push_scope(pctx);
  while (pctx.token.id != "}") {
    var stmt = parseStmt(pctx);
    
    top_scope( pctx).stmts.push(stmt+flush_newlines( pctx));
  }
  scan(pctx, "}");
  
  return gen_block(pop_scope(pctx).stmts.join(""));
}

function parseBlockLambdaBody(pctx) {
  
  push_scope(pctx);
  while (pctx.token.id != "}") {
    var stmt = parseStmt(pctx);
    
    top_scope( pctx).stmts.push(stmt+flush_newlines( pctx));;
  }
  scan(pctx, "}");
  
  return pop_scope(pctx).stmts.join("");
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
  
  return "{|"+gen_fun_pars(pars)+"| "+ body+"}";
}

S("{").
  exs(function(pctx) {
    var start = pctx.token.id;
    if (start == "|" || start == "||") {
      // block lambda
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
      
      var rv = "{";                                                       for (var i=0; i<props.length; ++i) {                                  if (i!=0) rv += ",";                                                if (props[i][0] == "prop") {                                          var v = props[i][1].replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"');       rv += v +":"+props[i][2];                               }                                                                   else if (props[i][0] == "method") {                                          var v = props[i][1].replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"');       rv += v+(props[i][2].replace(/^[^(]+/,''));                       }                                                                   else if (props[i][0] == "pat")                                        rv += props[i][1];                                                else if (props[i][0] == "get")                                        rv += "get " + props[i][1]+"()"+props[i][2];                      else if (props[i][0] == "set")                                        rv += "set " + props[i][1]+"("+props[i][2]+")"+props[i][3];     }                                                                   rv += "}";                                                          return rv;
    }
  }).
  // block lambda call:
  exc(260, function(l, pctx) {
    var start = pctx.token.id;
    if (start != "|" && start != "||")
      throw new Error("Unexpected token '"+pctx.token+"' - was expecting '|' or '||'");
    var args = [parseBlockLambda(start, pctx)];
    
    return l+"("+ args.join(",")+")";;
  }).
  // block:
  stmt(parseBlock);

// deliminators
S(";").stmt(function(pctx) {  return ";"; });
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
  
  push_scope(pctx);
  scan(pctx, "{");
  while (pctx.token.id != "}") {
    var stmt = parseStmt(pctx);
    
    top_scope( pctx).stmts.push(stmt+flush_newlines( pctx));
  }
  scan(pctx, "}");
  
  return gen_block(pop_scope(pctx).stmts.join(""));
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
    
    if (fname.length)                                           return "function "+fname+"("+gen_fun_pars( pars)+")"+ body;   else                                                        return "function("+gen_fun_pars( pars)+")"+ body;
  }).
  // statement function form ('function declaration')
  stmt(function(pctx) {
    if (pctx.token.id != "<id>") throw new Error("Malformed function declaration");
    var fname = pctx.token.value;
    scan(pctx);
    var pars = parseFunctionParams(pctx);
    var body = parseFunctionBody(pctx);
    
    return "function "+fname+"("+gen_fun_pars( pars)+")"+ body;
  });

S("this", TOKENIZER_OP).exs(function(pctx) {  return "this"; });
S("true", TOKENIZER_OP).exs(function(pctx) {  return "true"; });
S("false", TOKENIZER_OP).exs(function(pctx) {  return "false"; });
S("null", TOKENIZER_OP).exs(function(pctx) {  return "null"; });

S("collapse", TOKENIZER_OP).exs(function(pctx) {  return "collapse"; });

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
    if ('<string>' == "<string>")                                                   val = val.replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"');   else if ('<string>' == "<regex>")                                               val = val.replace(/\\/g,"\\\\").replace(/'/g,"\\'").replace(/"/g,'\\"');   return val;
  }
  return interpolating_string(parts);
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

  return quasi(parts);;
});

function parseQuasiInlineEscape(pctx) {
  // scan an identifier:
  var identifier = scan(pctx);
  if (pctx.token.id != "<id>") throw new Error("Unexpected " + pctx.token + " in quasi template");
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
    return identifier.exsf(pctx)+"("+ args.join(",")+")";
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
  
  var rv = "var ";                                 for (var i=0; i<decls.length; ++i) {               if (i) rv += ",";                                rv += decls[i][0];                               if (decls[i].length == 2)                          rv += "="+decls[i][1];                       }                                                return rv+";";
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
  
  var rv = "if("+test+")"+ consequent;                   if ( alternative !== null){                              if(  alternative[0] != "{")                              rv += "else "+ alternative;                          else                                                    rv += "else"+ alternative;                         }                                                     return rv;
});

S("while").stmt(function(pctx) {
  scan(pctx, "(");
  var test = parseExp(pctx);
  scan(pctx, ")");
  
  var body = parseStmt(pctx);
  
  
  return "while("+test+")"+ body;
});

S("do").stmt(function(pctx) {
  
  var body = parseStmt(pctx);
  
  scan(pctx, "while");
  scan(pctx, "(");
  var test = parseExp(pctx);
  scan(pctx, ")");
  parseStmtTermination(pctx);
  
  return "do "+body+"while("+ test+");";
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
    
    var body = parseStmt(pctx);
    
    
    var rv = "for(";                                                        if (start_exp) {                                                           rv += start_exp + ";";                                                 }                                                                       else if ( decls) {                                                       var d = (function( decls,  pctx) {                                            var rv = "var ";                                 for (var i=0; i< decls.length; ++i) {               if (i) rv += ",";                                rv +=  decls[i][0];                               if ( decls[i].length == 2)                          rv += "="+ decls[i][1];                       }                                                return rv+";"; })( decls,  pctx);                          rv += d;                                                                }                                                                       else                                                                      rv += ";";                                                            if ( test_exp) rv +=  test_exp;                                           rv += ";";                                                              if ( inc_exp) rv +=  inc_exp;                                             rv += ")";                                                              rv +=  body;                                                             return rv;
  }
  else if (pctx.token.id == "in") {
    scan(pctx);
    //XXX check that start_exp is a valid LHS
    if (decls && decls.length > 1)
      throw new Error("More that one variable declaration in for-in loop");
    var obj_exp = parseExp(pctx);
    scan(pctx, ")");
    
    var body = parseStmt(pctx);
    
    var decl = decls ? decls[0] : null;
    
    var rv = "for(";                                        if (start_exp) {                                            rv += start_exp;                                        }                                                       else {                                                  rv += "var "+ decl[0];                                   if ( decl.length > 1)                                      rv += "=" + decl[1];                                   }                                                       rv += " in " +  obj_exp + ")";                           rv +=  body;                                             return rv;
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
  
  var rv = "continue";                            if (label !== null)                                 rv += " "+label;                                return rv+";"
});

S("break").stmt(function(pctx) {
  var label = null;
  if (pctx.token.id == "<id>" && !pctx.newline) {
    label = pctx.token.value;
    scan(pctx);
  }
  parseStmtTermination(pctx);
  
  var rv = "break";                               if (label !== null)                                 rv += " "+label;                                return rv+";"
});

S("return").stmt(function(pctx) {
  var exp = null;
  if (!isStmtTermination(pctx.token) && !pctx.newline)
    exp = parseExp(pctx);
  parseStmtTermination(pctx);
  
  var rv = "return";                              if (exp != null)                                  rv += " "+exp;                                return rv+";";
});

S("with").stmt(function(pctx) {
  scan(pctx, "(");
  var exp = parseExp(pctx);
  scan(pctx, ")");
  var body = parseStmt(pctx);
  
  return "with("+exp+")"+ body;
});

S("case");
S("default");

S("switch").stmt(function(pctx) {
  scan(pctx, "(");
  var exp = parseExp(pctx);
  scan(pctx, ")");
  scan(pctx, "{");
  
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
    
    push_scope( pctx);                              top_scope( pctx).exp = clause_exp;
    while (pctx.token.id != "case" && pctx.token.id != "default" && pctx.token.id != "}") {
      var stmt = parseStmt(pctx);
      
      top_scope( pctx).stmts.push(stmt+flush_newlines( pctx));
    }
    clauses.push((function(pctx) {  var scope = pop_scope(pctx);                      var rv;                                           if (scope.exp)                                      rv = "case "+scope.exp+":";                     else                                                rv = "default:";                                return rv + scope.stmts.join(""); })(pctx));
  }
  
  scan(pctx, "}");
  
  return "switch("+exp+")"+gen_block( clauses.join(""));
});

S("throw").stmt(function(pctx) {
  if (pctx.newline) throw new Error("Illegal newline after throw");
  var exp = parseExp(pctx);
  parseStmtTermination(pctx);
  
  return "throw "+exp+";";;
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
    
    return "try"+block+gen_crf( crf);
  }
  else {
    var blocks = [block];
    do {
      scan(pctx);
      scan(pctx, "{");
      blocks.push(parseBlock(pctx));
    } while (pctx.token.value == op);
    var crf = parseCRF(pctx);
    
    var rv = "waitfor";                               for (var i=0; i< blocks.length; ++i){                if (i) rv += op;                                  rv +=  blocks[i];                                }                                                 rv += gen_crf( crf);                               return rv;
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
    
    var rv = "waitfor";                               for (var i=0; i< blocks.length; ++i){                if (i) rv += op;                                  rv +=  blocks[i];                                }                                                 rv += gen_crf( crf);                               return rv;
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
    
    
    var block = parseBlock(pctx);
    var crf = parseCRF(pctx);
    
    
    
    var rv = "waitfor(";                                   if (has_var) rv += "var ";                             for (var i=0; i< decls.length; ++i) {                     if (i) rv += ",";                                      rv +=  decls[i][0];                                     if ( decls[i].length == 2)                                rv += "="+ decls[i][1];                             }                                                      rv += ")" +  block;                                     rv += gen_crf( crf);                                    return rv;
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
  
  var rv = "using(";                                if (has_var) rv += "var ";                        if ( lhs) rv +=  lhs + "=";                         rv +=  exp + ")";                                  return rv +  body;
});

S("__js").stmt(function(pctx) {
  
  
  var body = parseStmt(pctx);
  
  
  
  return "__js "+body;
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
    var line = e.line || pctx.line;
    var exception = new Error("SJS syntax error "+(pctx.filename?"in "+pctx.filename+",": "at") +" line " + line + ": " + mes);
    exception.compileError = {message: mes, line: line};
    throw exception;
  }
}
exports.compile = compile;

function parseScript(pctx) {
  if (typeof pctx.scopes !== 'undefined')                        throw new Error("Internal parser error: Nested script");   pctx.scopes = [];                                            push_scope(pctx);
  scan(pctx);
  while (pctx.token.id != "<eof>") {
    var stmt = parseStmt(pctx);
    
    top_scope( pctx).stmts.push(stmt+flush_newlines( pctx));;
  }
  return '"'+pop_scope(pctx).stmts.join("")+'"';
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
    
    return t.value+": "+ stmt;
  }
  else {
    // an expression statement
    var exp = parseExp(pctx, 0, t);
    parseStmtTermination(pctx);
    
    return exp +";";
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
        var m = matches[1].match(/\n/g);
        if (m) {
          pctx.line += m.length;
          pctx.newline += m.length;
          add_newlines(m.length, pctx);
        }
        // go round loop again
      }
      else if (matches[5])
        pctx.token = new Literal("<string>", matches[5]);
      else if (matches[6]) {
        var val = matches[6];
        var m = val.match(/\n/g);
        pctx.line += m.length;
        pctx.newline += m.length;
        val = val.replace(/\\\n/g, "").replace(/\n/g, "\\n");
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
        var m = matches[1].match(/\n/g);
        if (m) {
          pctx.line += m.length;
          pctx.newline += m.length;
          add_newlines(m.length, pctx);
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

