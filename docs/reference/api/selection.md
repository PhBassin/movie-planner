# Selection API

Selection routes are Member-only. A Selection references existing active
Theaters; adding one never queues a scrape. The Selection is capped at 50
Theaters. A full Selection returns `409 Conflict` and includes the current count
in the error message.

## List My Selection

```http
GET /api/me/selection
```

**Authentication:** Required (Member)

**Response (200):**

```json
{
  "success": true,
  "data": [
    {
      "id": "W7504",
      "name": "Épée de Bois",
      "status": "active",
      "city": "Paris"
    }
  ]
}
```

## Add A Theater

```http
POST /api/me/selection/:theaterId
```

**Authentication:** Required (Member)

Adding an already-selected Theater is idempotent. Provisioning or missing
Theaters return `404`; reaching the cap returns `409`.

**Response (201):** The selected Theater in the standard API envelope.

## Remove A Theater

```http
DELETE /api/me/selection/:theaterId
```

**Authentication:** Required (Member)

The relationship is removed without deleting the shared Theater. The response
is `204 No Content`.

## Member Profile Fields

`GET /api/me` includes the Selection fields used by the client to disable add
controls before a cap conflict:

```json
{
  "selectionCount": 3,
  "selectionLimit": 50
}
```
