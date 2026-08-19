# Authentication API

## Authentication Endpoints

### User Login

```http
POST /api/auth/login
```

**Description:** Authenticate a user and receive a JWT token for accessing protected endpoints.

**Request Body:**
```json
{
  "username": "admin",
  "password": "admin"
}
```

**Response (200 — success):**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "username": "admin",
      "role_id": 1,
      "role_name": "admin",
      "is_system_role": true,
      "permissions": [
        "users:list",
        "users:create",
        "users:update",
        "users:delete",
        "users:read",
        "scraper:trigger",
        "scraper:trigger_single",
        "theaters:create",
        "theaters:update",
        "theaters:delete",
        "theaters:read",
        "settings:read",
        "settings:update",
        "settings:reset",
        "settings:export",
        "settings:import",
        "reports:list",
        "reports:view",
        "system:info",
        "system:health",
        "system:migrations",
        "roles:list",
        "roles:read",
        "roles:create",
        "roles:update",
        "roles:delete"
      ]
    }
  }
}
```

**Response (401 — invalid credentials):**
```json
{
  "success": false,
  "error": "Invalid credentials"
}
```

**Response (400 — missing fields):**
```json
{
  "success": false,
  "error": "Username and password are required"
}
```

**Example:**
```bash
# Login and save token
TOKEN=$(curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' | jq -r '.data.token')

# Use token for protected endpoints
curl http://localhost:3000/api/reports \
  -H "Authorization: Bearer $TOKEN"
```

**Note:** The default admin account is created automatically on first database initialization with username `admin` and password `admin`. **Change this password in production.**

---

### Sign Up (Member self-registration)

```http
POST /api/auth/signup
```

**Authentication:** None (public route)

**Description:** Create a **Member** account (see `CONTEXT.md` → Member). Members identify by email; Staff identify by username and are created by an Admin via `POST /api/auth/register` below. A freshly registered Member is `unverified` — it may log in, but cannot submit new cinemas until verified. No session is issued by this route; the Member logs in via `POST /api/auth/login` using their email as the username.

**Request Body:**
```json
{
  "email": "jane@example.com",
  "password": "Str0ng!Pass"
}
```

**Response (201 — created):**
```json
{
  "success": true,
  "data": {
    "message": "Account created successfully",
    "user": {
      "id": 2,
      "username": "jane@example.com",
      "email": "jane@example.com",
      "role_id": 3,
      "role_name": "member",
      "status": "unverified"
    }
  }
}
```

**Response (400 — weak password / invalid or duplicate email):**
```json
{
  "success": false,
  "error": "Password must be at least 8 characters"
}
```
```json
{
  "success": false,
  "error": "An account with this email already exists"
}
```

**Note:** A successful signup dispatches a **verification email** (see *Verify Email* below). The send is best-effort and fire-and-forget — a mailer failure never fails the registration; the Member can request a fresh link via *Resend Verification*.

---

### Verify Email

```http
POST /api/auth/verify-email
```

**Authentication:** None (public route — the link is opened from the Member's mailbox)

**Description:** Link target of the verification email. Consumes the token (strictly single-use, 30-minute lifetime, stored hashed) and flips the Member `unverified → active` (`email_verified_at` set; a suspended Member stays suspended). The SPA landing page is `/verify?token=...`. Rate-limited on the dedicated **verification** arm of RateLimitConfig (default 3/hour per IP).

**Request Body:**
```json
{
  "token": "raw-token-from-the-email"
}
```

**Response (200 — verified):**
```json
{
  "success": true,
  "data": { "message": "Email address verified" }
}
```

**Response (400 — unknown, expired, or missing token):**
```json
{
  "success": false,
  "error": "This verification link is invalid or has expired"
}
```

---

### Resend Verification

```http
POST /api/auth/resend-verification
```

**Authentication:** None (public route)

**Description:** Issue a fresh verification token (superseding any outstanding one) and send a new link. **Enumeration-safe:** the response is always `200` with the same body whether or not the email belongs to an unverified Member, and the send is dispatched **fire-and-forget** so the response latency cannot reveal whether the email matched (ADR 0006, sub-decision 6). No-op for Staff accounts and already-verified Members. Rate-limited on the dedicated **verification** arm of RateLimitConfig (default 3/hour per IP) — a separate budget from signup, so a Member is never stranded behind an exhausted register bucket.

**Request Body:**
```json
{
  "email": "jane@example.com"
}
```

**Response (200 — always):**
```json
{
  "success": true,
  "data": {
    "message": "If an unverified account exists for this email, a verification link is on its way."
  }
}
```

---

### Request Password Reset

```http
POST /api/auth/password-reset/request
```

**Authentication:** None (public route)

**Description:** Request a password-reset email for a Member account. The
response is always `200` with the same body for known, unknown, unverified, or
suspended email addresses. The work is dispatched after the response so email
delivery cannot be used as a timing oracle. The request is limited independently
by source IP and normalized email address to prevent both spraying and inbox
bombing.

**Request Body:**
```json
{
  "email": "jane@example.com"
}
```

**Response (200 — always):**
```json
{
  "success": true,
  "data": {
    "message": "If a Member account exists for this email, a password reset link is on its way."
  }
}
```

The email contains a link to `/reset-password?token=...`. Reset tokens are
hashed in storage, expire after 30 minutes, are single-use, and a new request
supersedes the previous outstanding token.

---

### Confirm Password Reset

```http
POST /api/auth/password-reset/confirm
```

**Authentication:** None (public route — the token from the Member's mailbox
is the credential)

**Request Body:**
```json
{
  "token": "raw-token-from-the-email",
  "newPassword": "NewStr0ng!Pass"
}
```

**Response (200 — success):**
```json
{
  "success": true,
  "data": {
    "message": "Password reset successfully. Please sign in again."
  }
}
```

The new password must satisfy the normal password-strength policy. A
successful reset revokes every Session and sends a token-less confirmation
email. It never issues a Session; the Member must sign in through
`POST /api/auth/login`.

**Response (400 — invalid, expired, reused, or superseded token):**
```json
{
  "success": false,
  "error": "This password reset link is invalid or has expired"
}
```

The endpoint shares the authentication failed-attempt budget (see
[Rate Limiting](./rate-limiting.md)): repeated failed confirmations from one
source IP are throttled with `429`, while successful resets do not consume
the budget.

---

### Member Profile

```http
GET /api/me
```

**Authentication:** Required (cookie or Bearer token)

**Description:** Return the authenticated Member's own profile — the seam the Member tickets hang Selection and Appearance data on. Member-only: a Staff account gets `403`. Distinct from `GET /api/auth/me`, which only validates the session and echoes token claims.

**Response (200):**
```json
{
  "success": true,
  "data": {
    "user": {
      "id": 2,
      "email": "jane@example.com",
      "username": "jane@example.com",
      "role_name": "member",
      "status": "unverified",
      "email_verified": false,
      "appearance": "light",
      "created_at": "2026-08-14T08:18:09.217Z"
    }
  }
}
```

**Notes:** `status` is the Member lifecycle discriminator (`unverified | active | suspended`). A `suspended` Member cannot log in (`POST /api/auth/login` returns `401 Account suspended`); an unverified Member can.

---

### Register New User

```http
POST /api/auth/register
```

**Authentication:** Required (Bearer token)  
**Role:** Admin only

**Description:** Create a new user account. Only administrators can register new users.

**Request Body:**
```json
{
  "username": "newuser",
  "password": "securepassword"
}
```

**Response (201 — created):**
```json
{
  "success": true,
  "data": {
    "message": "User registered successfully",
    "user": {
      "id": 2,
      "username": "newuser",
      "role": "user"
    }
  }
}
```

**Response (409 — username exists):**
```json
{
  "success": false,
  "error": "Username already exists"
}
```

**Response (401 — unauthorized):**
```json
{
  "success": false,
  "error": "Unauthorized"
}
```

**Response (403 — not admin):**
```json
{
  "success": false,
  "error": "Admin access required"
}
```

**Example:**
```bash
# Get admin token first
TOKEN=$(curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' | jq -r '.data.token')

# Register new user (admin only)
curl -X POST http://localhost:3000/api/auth/register \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"username":"newuser","password":"securepass123"}'
```

---

### Change Password

```http
POST /api/auth/change-password
```

**Authentication:** Required (Bearer token)

**Description:** Change the password for the currently authenticated user. Requires the current password for verification.

**Request Body:**
```json
{
  "currentPassword": "current_password",
  "newPassword": "new_secure_password"
}
```

**Response (200 — success):**
```json
{
  "success": true,
  "data": {
    "message": "Password changed successfully"
  }
}
```

**Response (401 — invalid current password):**
```json
{
  "success": false,
  "error": "Current password is incorrect"
}
```

**Response (400 — missing fields):**
```json
{
  "success": false,
  "error": "Current password and new password are required"
}
```

**Response (401 — unauthorized, no token):**
```json
{
  "success": false,
  "error": "Unauthorized"
}
```

**Example:**
```bash
# Get auth token first
TOKEN=$(curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"admin"}' | jq -r '.data.token')

# Change password
curl -X POST http://localhost:3000/api/auth/change-password \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"currentPassword":"admin","newPassword":"NewSecurePass123!"}'

# Verify new password works (should succeed)
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"username":"admin","password":"NewSecurePass123!"}'
```

**Security Notes:**
- Requires valid JWT token (must be logged in)
- Current password must be provided (prevents unauthorized password changes if session is hijacked)
- Failed password change attempts count toward rate limiting
- Password is hashed with bcrypt before storage (never stored in plaintext)

---

## Session Expiry Behavior

### JWT Token Expiry

All JWT tokens issued by the `/api/auth/login` endpoint have a configurable expiration time:

- **Default**: 1 hour from issue time
- **Configuration**: Set via `JWT_EXPIRES_IN` environment variable
- **Format**: Any valid `jsonwebtoken` duration string (e.g., `1h`, `7d`, `30m`)
- **Algorithm**: HS256 (HMAC with SHA-256)
- **No Refresh Tokens**: Users must re-login after expiry

**Example Configuration:**
```env
JWT_EXPIRES_IN=1h  # Default: 1 hour
JWT_EXPIRES_IN=7d   # Alternative: 7 days
JWT_EXPIRES_IN=30m  # Alternative: 30 minutes
```

### Client-Side Behavior

The React client implements **proactive token expiry handling**:

1. **At Login**: Client decodes JWT to extract `exp` (expiry timestamp)
2. **Timer Set**: `setTimeout` scheduled to fire exactly when token expires
3. **Auto-Logout**: When timer fires, user is automatically logged out
4. **User Feedback**: Login page shows "Votre session a expiré. Veuillez vous reconnecter."
5. **No Surprise Errors**: Users never encounter 401 errors from expired tokens

**Benefits:**
- Seamless UX with clear session expiry messaging
- No failed API requests due to expired tokens
- Consistent behavior across all browser tabs (via localStorage events)

### Server-Side Validation

All protected endpoints validate JWT tokens:

**401 Response on Expired Token:**
```json
{
  "success": false,
  "error": "Unauthorized"
}
```

**Note**: In practice, users rarely see this error because the client proactively logs them out before tokens expire. This 401 response typically only occurs if:
- User manually manipulates localStorage
- System clock skew between client and server
- User has multiple tabs with different token states

### Permission Updates Require Re-login

**Important**: Permissions are baked into the JWT at login time. If a user's role or permissions change:
- Changes do NOT take effect until user re-logs in
- Old token remains valid with old permissions until expiry
- User must logout and login again to receive updated permissions in new JWT

**Example Scenario:**
```
1. User logs in as 'operator' → JWT contains 9 operator permissions
2. Admin promotes user to 'admin' role (26 permissions)
3. User still has 9 permissions until they re-login
4. User must logout and login to receive new JWT with 26 admin permissions
```

See [Roles and Permissions Reference](../roles-and-permissions.md) for complete RBAC documentation.

---

**Last updated:** March 15, 2026

[← Back to API Reference](./README.md)
