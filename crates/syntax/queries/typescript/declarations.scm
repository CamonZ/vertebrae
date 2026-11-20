(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.class
(internal_module name: (_) @name) @definition.module
(public_field_definition name: (_) @name) @definition.field
(property_signature name: (_) @name) @definition.field
(enum_body name: (_) @name @definition.variant)
(enum_assignment name: (_) @name) @definition.variant
