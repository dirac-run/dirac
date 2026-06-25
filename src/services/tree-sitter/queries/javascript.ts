/*
- class definitions
- method definitions
- named function declarations
- arrow functions and function expressions assigned to variables
- doc comments
*/
export default `
;; NOTE: Patterns are split per value type (arrow_function vs function_expression) because
;; the v0.25 JavaScript grammar disallows alternation in certain positions.
(
  (comment)* @doc
  .
  (method_definition
    name: (property_identifier) @name.definition.method) @definition.method
  (#not-eq? @name.definition.method "constructor")
  (#strip! @doc "^[\\\\s\\\\*/]+|[\\\\s\\\\*/]+$")
  (#select-adjacent! @doc @definition.method)
)

(
  (comment)* @doc
  .
  [
    (class
      name: (_) @name.definition.class)
    (class_declaration
      name: (_) @name.definition.class)
  ] @definition.class
  (#strip! @doc "^[\\\\s\\\\*/]+|[\\\\s\\\\*/]+$")
  (#select-adjacent! @doc @definition.class)
)

(
  (comment)* @doc
  .
  [
    (function_declaration
      name: (identifier) @name.definition.function)
    (generator_function_declaration
      name: (identifier) @name.definition.function)
  ] @definition.function
  (#strip! @doc "^[\\\\s\\\\*/]+|[\\\\s\\\\*/]+$")
  (#select-adjacent! @doc @definition.function)
)

;; Object properties with arrow functions
(
  (comment)* @doc
  .
  (pair
    key: (property_identifier) @name.definition.method
    value: (arrow_function)) @definition.method
  (#strip! @doc "^[\\\\s\\\\*/]+|[\\\\s\\\\*/]+$")
  (#select-adjacent! @doc @definition.method)
)

(
  (comment)* @doc
  .
  (pair
    key: (property_identifier) @name.definition.method
    value: (function_expression)) @definition.method
  (#strip! @doc "^[\\\\s\\\\*/]+|[\\\\s\\\\*/]+$")
  (#select-adjacent! @doc @definition.method)
)

;; Class properties with arrow functions (field_definition has no 'name' field in JS grammar)
(
  (comment)* @doc
  .
  (field_definition
    (property_identifier) @name.definition.method
    value: (arrow_function)) @definition.method
  (#strip! @doc "^[\\\\s\\\\*/]+|[\\\\s\\\\*/]+$")
  (#select-adjacent! @doc @definition.method)
)

(
  (comment)* @doc
  .
  (field_definition
    (property_identifier) @name.definition.method
    value: (function_expression)) @definition.method
  (#strip! @doc "^[\\\\s\\\\*/]+|[\\\\s\\\\*/]+$")
  (#select-adjacent! @doc @definition.method)
)

;; Variable declarations with arrow functions
(
  (comment)* @doc
  .
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name.definition.function
        value: (arrow_function)))
    (variable_declaration
      (variable_declarator
        name: (identifier) @name.definition.function
        value: (arrow_function)))
  ] @definition.function
  (#strip! @doc "^[\\\\s\\\\*/]+|[\\\\s\\\\*/]+$")
  (#select-adjacent! @doc @definition.function)
)

(
  (comment)* @doc
  .
  [
    (lexical_declaration
      (variable_declarator
        name: (identifier) @name.definition.function
        value: (function_expression)))
    (variable_declaration
      (variable_declarator
        name: (identifier) @name.definition.function
        value: (function_expression)))
  ] @definition.function
  (#strip! @doc "^[\\\\s\\\\*/]+|[\\\\s\\\\*/]+$")
  (#select-adjacent! @doc @definition.function)
)

;; References
(identifier) @name.reference
(property_identifier) @name.reference
`
