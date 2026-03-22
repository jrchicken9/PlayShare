# Privacy Policy for PlayShare

**Last updated:** March 22, 2026

## 1. Introduction

PlayShare (“we”, “our”, or “us”) is a browser extension that helps people watch streaming content together in sync and communicate via chat. This Privacy Policy explains how we handle information when you use PlayShare.

**Data controller / operator:** **Ibrahim Haddad**. For questions about this Policy, see [Section 13. Contact](#13-contact).

By installing or using PlayShare, you agree to the practices described in this policy.

---

## 2. What PlayShare is

PlayShare runs on **supported streaming websites** only. It provides **text chat**, room codes, and synchronized playback with others. **Each user must have their own lawful access** to the streaming service they use. PlayShare does not supply video, does not sell third-party subscriptions, and is **not affiliated with** streaming platform operators.

The Extension reads **playback state** from the page to stay in sync; it does **not** upload the video stream to us.

---

## 3. Information we collect

We collect and process only what is needed to run the core features, plus optional account features where you choose to use them.

### a) User-provided information

- **Chat messages** you send in a room  
- **Display name** and similar fields you choose (shown to other participants)  
- **Optional sign-in:** if you create or use an account, **email address** and **password** (or other credentials) are sent to our authentication provider (**Supabase**) over TLS—not to the signaling server as part of normal chat/sync

### b) Information stored on your device

The Extension uses **`chrome.storage.local`** for items such as room state, display name, signaling server URL (default or **custom**), pending join codes, optional **auth session** tokens, and UI preferences. This stays on your device until you clear it, sign out, or remove the Extension.

### c) Information processed in real time (signaling server)

To coordinate rooms, the Extension uses **WebSocket** to a **signaling server** (by default ours on a host such as Railway; you may point to another server where the product allows). That traffic can include:

- **Room / session identifiers** (e.g. room codes, client IDs)  
- **Display name** and **presence** (e.g. color)  
- **Chat messages** and related metadata (e.g. sender name)  
- **Playback coordination** — play, pause, seek, timeline-related values, timestamps, and other protocol fields needed for sync  
- **Other protocol messages** for features you use (e.g. reactions, typing indicators)

**Do not** put passwords, payment data, government IDs, or similarly sensitive information in chat or your display name.

### d) Automatically collected / technical information

- **Technical data required for communication** (including basic **connection data** needed to establish real-time sessions), used as needed to operate, secure, and troubleshoot the service. We do **not** use the Extension to collect precise **GPS** location from your device.  
- **Page URLs** may be included in invites so others can open the same title; that is a **link**, not a copy of the video file.

### e) What we do not use PlayShare to collect

- Passwords or full credentials for **third-party streaming** accounts  
- Payment card numbers for in-Extension purchases  
- A general log of **every** website you visit (access is limited to declared supported sites)  
- Keystroke logging or mouse tracking for **advertising** or **profiling**

If any short summary of our practices conflicts with this Policy, **this document controls** unless applicable law says otherwise.

---

## 4. How we use information

We use the information above strictly to:

- Enable **synchronized playback** between users  
- Deliver **real-time chat** and room features  
- Operate, secure, and improve the **signaling service** (including abuse prevention and troubleshooting)  
- Provide **optional accounts** and sessions through **Supabase** when you sign in  
- Build **invite links** that may include room codes and watch URLs

We do **not** use your data for:

- **Advertising** or ad profiling  
- **Selling** personal information to third parties

---

## 5. Data sharing

We do **not** sell, rent, or trade your personal information.

Data is processed through secure servers to enable real-time synchronization and messaging.

Information may be:

- **Visible or delivered to other participants** in a session (e.g. chat, playback state, display name)  
- **Processed on our servers** (or infrastructure providers such as hosting / edge networks) solely to run sync, chat, and the public **privacy policy page**  
- **Sent to Supabase** when you use optional sign-in, under their terms: https://supabase.com/privacy  
- **Processed by a custom signaling server** if you configure one—we are not responsible for that operator’s practices

We may disclose information if **required by law** or to protect **rights, safety, and security**.

---

## 6. Data storage and retention

- **Chat and live session data** on our default signaling path are **ephemeral** in nature: they exist to deliver real-time sync and chat and are **not** kept as a long-term message archive or user profile database **on that server**. Retention on infrastructure may still include **short-lived processing**, **security logs**, or **backups** as needed to operate and secure the service.  
- **On your device**, data in `chrome.storage.local` remains until you clear extension data or uninstall.  
- **Optional accounts:** Supabase may **store** account-related data (e.g. email) according to their service and your use of sign-in—this is **not** the same as “no accounts anywhere.” If you do not sign in, Supabase account data above does not apply.

We do **not** build advertising profiles from PlayShare usage.

---

## 7. Security

All data is transmitted using secure encryption protocols (HTTPS/WSS).

We use **TLS** for connections where configured (e.g. default production signaling server and optional Supabase sign-in). No method of transmission over the internet is 100% secure; please avoid sharing highly sensitive information in chat or room fields.

---

## 8. Third-party services

PlayShare does not access, collect, or store login credentials or account data from any third-party streaming services.

- **Streaming platforms** (e.g. Netflix, Prime Video): PlayShare interacts with the page you are on for sync and chat only; it does **not** read or harvest your **streaming login** or credentials for those services. We are **not responsible** for their privacy practices.  
- **Supabase:** optional authentication.  
- **Hosting / infrastructure** (e.g. cloud or edge providers): may process network and service metadata when you connect.

---

## 9. International transfers

If you use PlayShare from outside the country where servers are located, information may be **transferred to** and **processed in** other countries where privacy laws may differ.

---

## 10. Your privacy rights and choices

Depending on your location, you may have rights to access, correct, delete, or object to certain processing. Because much of our processing is **session-based**, you can also:

- **Leave a room** or **uninstall** the Extension  
- **Clear** PlayShare data in Chrome’s extension settings  
- **Avoid optional sign-in** if you do not want Supabase to process account data  
- **Avoid custom servers** you do not trust  

For requests that apply to **Supabase-held** account data, you may need to use their tools or contact us as below.

---

## 11. Children’s privacy

PlayShare is **not intended for children under 13**, and we do not knowingly collect personal information from children. If you believe we have done so, contact us and we will take appropriate steps.

---

## 12. Changes to this policy

We may update this Privacy Policy from time to time. We will revise the **Last updated** date at the top when we do. Continued use after changes means you accept the updated policy, except where applicable law requires more.

---

## 13. Contact

If you have questions about this Privacy Policy:

**Primary (privacy inquiries):** [i.haddad009@gmail.com](mailto:i.haddad009@gmail.com)

**Support email:** We plan to offer **support@playshare.app** in the future; until that address is active, please use the email above.

---

## 14. Summary (plain English)

- We only process what’s needed for **sync**, **chat**, **rooms**, and **optional sign-in**.  
- We **don’t** sell your data or use it for **ads** or **profiling**.  
- Live room traffic is **temporary** on our signaling path—not a long-term chat archive; **device** storage and **Supabase** (if you sign in) work differently, as described above.  
- We **don’t** access streaming accounts or store streaming **logins**; third-party sites have their own policies.  
- **HTTPS/WSS** encryption applies for default production and sign-in where configured.

---

© 2026 Ibrahim Haddad
