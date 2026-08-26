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

## Selection Homepage Movies

```http
GET /api/me/selection/movies
GET /api/me/selection/movies?date=YYYY-MM-DD
```

**Authentication:** Required (Member)

Returns movies and showtimes at the Member's selected active Theaters. Without
`date`, the response covers the current Wednesday-to-Tuesday week. With a date,
it returns only that day's showtimes. Each theater in the response may include
`isNewThisWeek`; the movie-level flag is true when at least one selected
Theater has newly programmed the Movie this week. Provisioning Theaters and
non-selected Theaters are never returned.

**Response (200):**

```json
{
  "success": true,
  "data": {
    "weekStart": "2026-03-25",
    "movies": [
      {
        "id": 123,
        "title": "Movie Title",
        "isNewThisWeek": true,
        "theaters": [
          {
            "id": "W7504",
            "name": "Épée de Bois",
            "isNewThisWeek": true,
            "showtimes": []
          }
        ]
      }
    ]
  }
}
```

## Selection Movie Search

```http
GET /api/me/selection/movies/search?q={query}
```

**Authentication:** Required (Member)

Search results are limited to Movies with showtimes at the authenticated
Member's selected active Theaters. The query must contain 2 to 100 characters;
up to 10 results are returned.
