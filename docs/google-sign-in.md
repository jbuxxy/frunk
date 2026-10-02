# Google sign-in

Google sign-in is optional. Without it, people sign in with a password from
their invite link.

## Set up a Google OAuth client

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
   create an **OAuth client ID** of type **Web application**.
2. Under **Authorized JavaScript origins**, add your Frunk address, e.g.
   `https://frunk.example.com`. This powers the one-tap "Continue as …" button.
3. Under **Authorized redirect URIs**, add
   `https://frunk.example.com/auth/google/callback`.
4. In **Google Auth Platform → Audience**, publish the app. While it's in
   *Testing*, only listed test users can sign in.
5. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in your environment and
   restart Frunk.

Google sign-in doesn't let strangers in. Only the admin, existing members, and
people with a live invite can create an account.

## Testing locally

Add `http://localhost:3000` and `http://localhost` to the client's JavaScript
origins, and `http://localhost:3000/auth/google/callback` as a redirect URI.
