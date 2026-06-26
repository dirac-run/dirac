/*
- class, protocol, struct, enum declarations
- function and method definitions
- property declarations
- type alias declarations
*/
export default `
;; Classes
(class_declaration
  name: (type_identifier) @name.definition.class) @definition.class

;; Protocols (Interfaces)
(protocol_declaration
  name: (type_identifier) @name.definition.interface) @definition.interface

;; Functions
(function_declaration
  name: (simple_identifier) @name.definition.function) @definition.function

;; Methods (functions inside class/struct/protocol)
(class_body
  [
    (function_declaration
      name: (simple_identifier) @name.definition.method)
    (init_declaration "init" @name.definition.method)
    (deinit_declaration "deinit" @name.definition.method)
  ] @definition.method)

;; Properties
(property_declaration
  (pattern (simple_identifier) @name.definition.property)) @definition.property

;; Type Aliases
(typealias_declaration
  name: (type_identifier) @name.definition.type) @definition.type

;; Closures assigned to variables
(property_declaration
  (pattern (simple_identifier) @name.definition.function)
  (lambda_literal)) @definition.function

;; References
(simple_identifier) @name.reference
(type_identifier) @name.reference
`
