/**
 @summary Standard test utilities
 @re-exports-dependencies
 @desc
   This module exports all symbols from the following modules:
    - [./suite::]
    - [../std::]

   Typically, test modules will use this module as:

       @ = require('sjs:test/std');
*/
module.exports = require(['./suite', '../std']);
