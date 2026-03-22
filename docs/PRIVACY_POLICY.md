# PlayShare — Privacy Policy

**Effective date:** March 22, 2026  

This Privacy Policy describes how the **PlayShare** browser extension (“**Extension**”) and related services (“**Services**”) collect, use, and share information when you use the Extension. It is intended to support publication on the **Chrome Web Store** and to align with the data disclosures you provide there.

**Operator:** **Ibrahim Haddad** (“**we**,” “**us**,” “**our**”).  
**Contact:** **i.haddad009@gmail.com** — for privacy and support questions. Use the same address as your **Chrome Web Store** developer contact so the listing matches this policy.

By installing or using the Extension, you agree to this policy. If you do not agree, do not use the Extension.

---

## 1. What PlayShare is

PlayShare lets people watch video on **supported streaming websites** in better sync with friends and includes **text chat** and room features (for example, invites and room codes). **Each viewer must have their own legitimate access** to the streaming service they use. PlayShare does not provide video content, does not sell subscriptions, and is **not affiliated** with streaming platforms.

---

## 2. Information we collect and process

We process information in the categories below. This matches the Chrome Web Store “Data usage” disclosures for personally identifiable information, personal communications, authentication information, location (network identifiers), and website content (hyperlinks), where applicable.

### 2.1 Information stored on your device (Chrome local storage)

The Extension uses **`chrome.storage.local`** to store items such as:

- **Room state** — for example room code, whether you are host, member list metadata the Extension needs to function, and related session fields.  
- **Display name** — the name you choose (or that is derived from optional account sign-in) for use in rooms.  
- **Signaling server URL** — default server address or a **custom** server you configure (for example via invite links or advanced setup).  
- **Pending join codes** or similar short-lived values used to complete join flows.  
- **Optional authentication session data** — if you use sign-in, tokens or session identifiers required to keep you logged in (managed with Supabase as described below).  
- **UI preferences** — for example sidebar-related settings stored by the Extension.

This data remains on your device unless a feature below sends derived or related information to our servers or third parties.

### 2.2 Information sent to the signaling server (WebSocket)

To coordinate rooms, the Extension communicates over **WebSocket** with a **signaling server** (by default operated by us or our hosting provider; you may point the Extension at another server if that feature is available). That traffic may include:

- **Room identifier** (room code) and **client/session identifiers** generated for the session.  
- **Display name** and **color** or similar presence fields shown to other participants.  
- **Chat messages** and related metadata needed to deliver chat (for example sender name).  
- **Playback coordination messages** — for example play, pause, seek, and timeline-related values used to keep participants aligned, plus technical fields (timestamps, correlation identifiers, latency-related hints where used).  
- **Other room messages** the product uses for features you enable (for example reactions, typing indicators, diagnostics the Extension sends by design).

**Do not post** passwords, payment card data, government ID numbers, or other highly sensitive information in chat or display names.

### 2.3 Network and location-related identifiers

Like most internet services, servers that terminate your WebSocket or HTTPS connections may observe **network identifiers**, including **IP addresses** and derived **approximate location** (such as region inferred from IP by infrastructure or analytics tools). We use this category in the ordinary course of operating and securing servers (for example abuse prevention, debugging, capacity planning).

We do **not** use the Extension to collect **GPS coordinates** from your device.

### 2.4 Website content: watch page links (hyperlinks)

For **invites** and **one-tap join** style flows, the Extension may store or transmit a **URL** of the watch page you are on (an **HTTPS hyperlink**) so others can open the same title. That URL is **website content** in the sense of a link to a specific page; it is **not** a copy of the video file.

The Extension reads the **playback state** from the page’s video element to perform sync; it does **not** upload the video stream to us.

### 2.5 Optional sign-in (authentication)

If you use **email/password or other sign-in** offered in the Extension, **Supabase** (or a comparable provider configured in the build) processes authentication on our behalf. That processing can involve:

- **Email address** and **password** (or other credentials you submit) sent to Supabase over TLS for authentication.  
- **Session tokens** or similar credentials returned to the Extension and stored locally so you stay signed in until you sign out.

The Extension includes Supabase client configuration (including a **publishable/anon key**) required for the client to talk to Supabase. **Supabase’s privacy policy** governs their processing: https://supabase.com/privacy  

Guest mode may be available without creating an account; if you avoid sign-in, Supabase auth data above is not used.

### 2.6 What we do **not** intentionally collect via the Extension

- **Streaming account passwords** for Netflix, YouTube, or other platforms (we do not ask for them in PlayShare).  
- **Payment card numbers** or **financial account** details for purchases inside the Extension.  
- **Browsing history** as a general log of every site you visit (the Extension runs only on declared supported sites).  
- **Keystroke logging** or **mouse tracking** for advertising profiling.

If this policy and the Chrome Web Store disclosures ever disagree, we will update this policy and the store listing to resolve the conflict.

---

## 3. How we use information

We use the information above to:

- Provide **room creation, join, sync, and chat**.  
- Operate, secure, and improve the **signaling service** (including troubleshooting and abuse prevention).  
- Provide **optional accounts** and session maintenance through Supabase (if enabled).  
- Generate **invite links** that may include room codes and optional watch URLs.

We do **not** sell your personal information.

---

## 4. How we share information

- **Hosting / infrastructure providers** that run the signaling server or related backends may process data on our behalf under contractual obligations.  
- **Supabase** receives authentication-related data when you use sign-in features.  
- **Custom signaling servers**: if you configure a non-default server, your room traffic is processed by that operator under their practices—we are not responsible for third-party servers you choose.

We may disclose information if required by **law**, legal process, or to protect **rights, safety, and security**.

---

## 5. Retention

- **Server-side**: we retain signaling and chat-related data only as long as needed for **session operation**, **security**, and **legal obligations**. Exact retention can vary by log type and infrastructure; we may delete or aggregate data over time.  
- **Device-side**: data in `chrome.storage.local` remains until you **remove** it, **clear extension data**, or **uninstall** the Extension.

---

## 6. Security

We use **HTTPS/WSS** (TLS) for client connections where configured. No method of transmission or storage is 100% secure; use PlayShare only for information you are comfortable sharing with others in the same room.

---

## 7. Children’s privacy

PlayShare is **not directed to children under 13** (or the minimum age of digital consent in your jurisdiction). Do not use the Extension if you are below that age. If you believe we have collected a child’s information, contact us and we will take appropriate steps.

---

## 8. International users

If you access the Services from outside the country where servers are located, your information may be **transferred** to and processed in other countries where privacy laws may differ.

---

## 9. Your choices

- **Leave a room** or **uninstall** the Extension.  
- **Clear** PlayShare data in Chrome: `chrome://extensions` → PlayShare → **Remove** or **Clear storage** (wording may vary by Chrome version).  
- **Avoid optional sign-in** if you do not want Supabase authentication.  
- **Do not use custom servers** you do not trust.

---

## 10. Changes to this policy

We may update this Privacy Policy from time to time. We will change the **Effective date** at the top when we do. Continued use after the update means you accept the revised policy. Material changes may also be reflected in the Chrome Web Store listing where required.

---

## 11. Contact

**Ibrahim Haddad**  
**Email:** i.haddad009@gmail.com  

Privacy and support inquiries: write to the email above. It should match the developer contact email on the PlayShare **Chrome Web Store** listing.

---

**Hosted copy (production):** After you deploy to Railway, use  
`https://<your-railway-host>/privacy`  
(e.g. `https://playshare-production.up.railway.app/privacy` if that is your service URL). The static HTML lives in **`public/privacy.html`**; keep it in sync when you edit this markdown. Paste that **HTTPS** URL into your Chrome Web Store listing.
