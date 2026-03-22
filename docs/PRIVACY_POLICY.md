# PlayShare — Privacy Policy

**Effective date:** March 22, 2026

This Privacy Policy describes how the **PlayShare** browser extension (the “**Extension**”) and related services (the “**Services**”) collect, use, disclose, and protect information when you use the Extension.

**Data controller / operator:** **Ibrahim Haddad** (“**we**,” “**us**,” “**our**”).  
**Contact for privacy inquiries:** **i.haddad009@gmail.com**

By installing or using the Extension, you acknowledge this policy. If you do not agree, please do not use the Extension.

---

## 1. What PlayShare is

PlayShare helps people watch video on **supported streaming websites** in sync with others and provides **text chat** and room features (such as invites and room codes). **Each user must have their own lawful access** to the streaming service they use. The Extension does not supply video content, does not sell subscriptions to third-party services, and is **not affiliated with** streaming platform operators.

---

## 2. Information we collect and process

We process the categories of information described below. They may correspond to labels used in app store or regulatory disclosures (for example, identifiers, communications content, authentication data, network or location-related identifiers, and links to web pages).

### 2.1 Information stored on your device

The Extension uses the browser’s local storage API (**`chrome.storage.local`**) for data such as:

- **Room state** — e.g. room code, host status, member metadata needed for the Extension to operate, and related session fields.  
- **Display name** — the name you provide or that is associated with optional sign-in.  
- **Signaling server address** — the default server or a **custom** server you configure (e.g. via invite parameters or advanced settings).  
- **Pending join codes** and similar short-lived values used to complete join flows.  
- **Authentication session data** — if you use sign-in, tokens or session identifiers needed to maintain your session (see Supabase below).  
- **Interface preferences** — e.g. sidebar-related settings.

This information remains on your device unless transmitted as described in the following sections.

### 2.2 Information processed by the signaling server

To coordinate rooms, the Extension communicates over **WebSocket** with a **signaling server** (by default operated by us or our hosting provider; you may configure another server where the product allows). That processing may include:

- **Room identifier** (room code) and **client or session identifiers** generated for the session.  
- **Display name** and **presence** fields (e.g. color) shown to other participants.  
- **Chat messages** and related metadata (e.g. sender name).  
- **Playback coordination data** — e.g. play, pause, seek, and timeline-related values, and technical fields such as timestamps or correlation identifiers where used.  
- **Other protocol messages** required for features you use (e.g. reactions, typing indicators, or diagnostic messages sent by the Extension as designed).

Do not submit passwords, payment card numbers, government identifiers, or other highly sensitive data in chat or as a display name.

### 2.3 Network and location-related identifiers

Servers that receive your connections may process **network identifiers**, including **IP addresses**. IP addresses may be used to derive **approximate** geographic information (e.g. region). We use such data in the ordinary course of operating, securing, and maintaining the Services (e.g. abuse prevention, troubleshooting, capacity planning).

We do **not** use the Extension to collect precise **GPS** location from your device.

### 2.4 Page links (URLs)

For invites and similar flows, the Extension may store or transmit the **URL** of the watch page you are viewing so others can open the same title. That is a link to a page; it is **not** a copy of the video file.

The Extension reads **playback state** from the page’s media element to perform sync; it does **not** upload the video stream to us.

### 2.5 Optional sign-in (authentication)

If you use email/password or other sign-in offered in the Extension, **Supabase** (or another provider configured in the build) may process authentication on our behalf, including:

- **Email address** and **password** (or other credentials) transmitted to Supabase over TLS.  
- **Session tokens** or similar credentials returned to the Extension and stored locally until you sign out.

The Extension uses Supabase client configuration (including a publishable client key) as required for that integration. Supabase’s handling of personal data is described in its privacy policy: https://supabase.com/privacy

Guest use may be available without an account; if you do not sign in, the authentication data above does not apply.

### 2.6 What we do not use the Extension to collect

- Passwords for third-party streaming accounts (we do not request them in PlayShare).  
- Payment card numbers or financial account details for in-Extension purchases.  
- A general log of all websites you visit (the Extension is limited to declared supported sites).  
- Keystroke logging or mouse tracking for advertising profiling.

If any abbreviated summary of our practices conflicts with this Policy, this document prevails unless applicable law requires otherwise.

---

## 3. How we use information

We use the information above to:

- Provide and operate **rooms, sync, and chat**.  
- Operate, secure, and improve the **signaling service** (including troubleshooting and abuse prevention).  
- Provide **optional accounts** and maintain sessions through Supabase where enabled.  
- Generate **invite links** that may include room codes and optional watch URLs.

We do **not** sell your personal information.

---

## 4. How we share information

- **Service providers** (e.g. hosting or infrastructure) may process data on our behalf under appropriate safeguards.  
- **Supabase** receives authentication-related data when you use sign-in features.  
- If you use a **non-default signaling server**, your room traffic is processed by that operator; we are not responsible for their practices.

We may disclose information if required by **law**, regulation, legal process, or to protect **rights, safety, and security**.

---

## 5. Retention

- **Server-side:** we retain data only as long as needed for **operating the Services**, **security**, and **legal obligations**. Retention periods may vary by data type; we may delete or aggregate data over time.  
- **Device-side:** data in `chrome.storage.local` remains until you remove it, clear extension data, or uninstall the Extension.

---

## 6. Security

We use **TLS** (HTTPS/WSS) for connections where configured. No electronic transmission or storage is completely secure; please avoid sharing sensitive information in chat or room fields.

---

## 7. Children’s privacy

The Extension is **not directed to children under 13** (or the age of digital consent in your jurisdiction, if higher). Do not use the Extension if you are below that age. If you believe we have collected information from a child inappropriately, contact us using the email below and we will take appropriate steps.

---

## 8. International transfers

If you access the Services from outside the country where servers are located, your information may be **transferred to** and **processed in** other countries where privacy laws may differ.

---

## 9. Your choices

- Leave a room or uninstall the Extension.  
- Clear Extension data in Chrome via extension settings (e.g. remove the Extension or clear stored data for it).  
- Avoid optional sign-in if you do not want Supabase authentication.  
- Do not connect to custom servers you do not trust.

---

## 10. Changes to this policy

We may update this Privacy Policy periodically. We will revise the **Effective date** at the top when we do. Continued use of the Extension after changes constitutes acceptance of the updated policy, except where applicable law requires additional notice or consent.

---

## 11. Contact

**Ibrahim Haddad**  
**Email:** i.haddad009@gmail.com  

For privacy-related requests or questions about this Policy, please contact us at the email above.

---

© 2026 Ibrahim Haddad
