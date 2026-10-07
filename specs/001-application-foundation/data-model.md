# Phase 1: Foundation Data Model

## Entities

### `users` (Identity)
- `id`: UUID (Primary Key)
- `username`: String (Unique, canonical login identifier)
- `password_hash`: String (Argon2id)
- `is_active`: Boolean (Default: true)
- `created_at`: Timestamp
- `updated_at`: Timestamp

### `sessions`
- `id`: String (SHA-256 Digest of Secure Opaque Token)
- `user_id`: UUID (Foreign Key to `users`)
- `expires_at`: Timestamp
- `created_at`: Timestamp

### `roles` (Roles boundary)
- `id`: String (Primary Key, explicit identifier e.g., 'ADMINISTRATOR', 'SYSTEM_MAINTAINER')
- `description`: String

### `user_roles`
- `user_id`: UUID (Foreign Key)
- `role_id`: String (Foreign Key)

## Capability Mapping (Code-Defined)
Capabilities (e.g., `system:maintain`) are NOT persisted in the database to prevent enterprise RBAC complexity. The application code strictly maps `roles` to current capabilities and dynamically evaluates them per request based on the user's active `roles`.

## Audit Context Primitive (Logical Concept)
*Note: This is an explicitly typed API object or embedded set of columns, NOT a generic audit table framework.*
- `actor`: UUID (Foreign Key to `users`. API representation uses `actor` logically mapping to the actor executing the action).
- `action`: String (Mandatory explicit identifier of the business action)
- `recorded_at`: Timestamp
