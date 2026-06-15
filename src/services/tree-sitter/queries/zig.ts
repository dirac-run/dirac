/*
- function definitions (top-level and in containers)
- struct, enum, union declarations
- container fields (struct/enum/union members)
- test declarations
- doc comments
*/
export default `
;; Functions
(
  (comment)* @doc
  .
  (function_declaration
    name: (identifier) @name.definition.function) @definition.function
  (#strip! @doc "^///\\\\s*")
  (#select-adjacent! @doc @definition.function)
)

;; Structs (Classes)
(
  (comment)* @doc
  .
  (variable_declaration
    (identifier) @name.definition.class
    (struct_declaration)) @definition.class
  (#strip! @doc "^///\\\\s*")
  (#select-adjacent! @doc @definition.class)
)

;; Enums (Classes)
(
  (comment)* @doc
  .
  (variable_declaration
    (identifier) @name.definition.class
    (enum_declaration)) @definition.class
  (#strip! @doc "^///\\\\s*")
  (#select-adjacent! @doc @definition.class)
)

;; Unions (Classes)
(
  (comment)* @doc
  .
  (variable_declaration
    (identifier) @name.definition.class
    (union_declaration)) @definition.class
  (#strip! @doc "^///\\\\s*")
  (#select-adjacent! @doc @definition.class)
)

;; Container fields (struct/enum/union members)
(container_field
  name: (identifier) @name.definition.field) @definition.field

;; References
(identifier) @name.reference
`
