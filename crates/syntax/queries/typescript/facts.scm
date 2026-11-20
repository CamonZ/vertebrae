(public_field_definition name: (_) @data.field.subject) @data.field
(property_signature name: (_) @data.field.subject) @data.field
(type_annotation (_) @data.type)
(type_alias_declaration value: (_) @data.type)

(accessibility_modifier) @api.visibility
(export_statement
  declaration: (function_declaration return_type: (type_annotation (_) @api.signature)))

(non_null_expression "!" @error.unwrap.subject) @error.unwrap
