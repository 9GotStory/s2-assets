# API Error Contract

This contract defines the standard error response format for all REST API endpoints (FR-011).

## Standard JSON Error Response

```json
{
  "error": {
    "code": "ERROR_CODE_STRING",
    "message": "Human-readable safe description",
    "request_id": "req-correlation-uuid",
    "details": {
      // Strictly minimized validation details. NO internal stack, query, or secret leakage.
    }
  }
}
```

## Examples

**Validation Error (400)**
```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "The provided request data is invalid.",
    "request_id": "123e4567-e89b-12d3-a456-426614174000",
    "details": {
      "username": "Required field missing"
    }
  }
}
```
