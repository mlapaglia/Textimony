# Textimony
What your SMS, Google Chat and WhatsApp messages reveal about you

1. Export your messages:
   - **SMS / MMS:** back up your Android Google Messages chats using [SMS Backup & Restore](https://play.google.com/store/apps/details?id=com.riteshsahu.SMSBackupRestore).
   - **Google Chat:** go to [Google Takeout](https://takeout.google.com/), click "Deselect all", select only **Google Chat**, and export as a **.zip**. Large exports are split into several zips (`takeout-…-001.zip`, `-002.zip`, …); download all of them. Dates are only understood when your Google account language is English.
   - **WhatsApp:** open a chat, then ⋮ / the contact or group name → **Export chat** (with or without media). Repeat for each chat you want; you get `WhatsApp Chat with ….txt` (Android) or `WhatsApp Chat - ….zip` (iPhone).
2. Navigate to https://mlapaglia.github.io/Textimony/
3. Import the xml backup(s), Takeout zip(s) and/or WhatsApp exports. Pick every part of a split Takeout export together. WhatsApp exports don't say which sender is you; the app guesses, and you can correct it with **You on WhatsApp**.
4. Look at fancy graphs! When both kinds are loaded, use the All / SMS / Google Chat / WhatsApp switch to compare them.

All processing occurs in the browser, your data is never uploaded anywhere!

<img width="1064" height="1236" alt="Image" src="https://github.com/user-attachments/assets/74e4e8a4-ff34-40c2-b986-98076340d8ce" />