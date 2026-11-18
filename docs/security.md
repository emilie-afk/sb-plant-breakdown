# Security and data handling

Plant Revenue Breakdown is an internal Succulents Box tool. The repository is public; the data is not.

- **Access.** Team members sign in with Google. Only accounts on a private allow-list get a session, and a smaller list of editors can change settings or upload files. Access is checked on every request, so removing someone takes effect immediately.
- **Data.** Sales and product data are stored in a private database. The public page contains no data, keys or storage addresses. It reaches data only through the site's own server functions after sign-in, and those functions hold the storage keys.
- **Uploads.** Report files from the team's collector are sent straight to the private database with their own credential. They never pass through the browser or the repository.
- **Configuration.** Credentials, allow-lists and limits are private server settings. The repository contains code, synthetic test data and generic documentation only.

Deployment steps, endpoint details, limits and incident notes are kept in the team's private operator guide. Report a security concern to the repository owner privately rather than in a public issue.
