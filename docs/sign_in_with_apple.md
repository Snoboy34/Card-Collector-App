# Sign in with Apple — what to switch on

The Apple Developer team in this Xcode project is `8R89NQ33MV`. The app bundle id is `com.cardgrader.thejudge`. The name on the phone is CardGrade. The server expects that bundle id as the token audience unless `data/beta_flags.json` sets a different `appleAudience`.

Do this before the next archive. The project now includes the Sign in with Apple entitlement, so a signed build fails until the App ID has the capability.

The iMac does not need an Apple private key. It checks Apple’s public keys. Do not create a Sign in with Apple key, and do not create a Services ID. A Services ID is only for a website login, which this beta does not turn on.

## 1. Turn the capability on for the App ID

1. Open [Certificates, Identifiers & Profiles](https://developer.apple.com/account/resources/identifiers/list).
2. Open Identifiers. Select the App ID whose bundle id is `com.cardgrader.thejudge`.
3. If that identifier is not in the list, the CardGrade app in App Store Connect is using a different bundle id. Stop and use that bundle id as `appleAudience`. Do not invent a second App ID.
4. Enable **Sign in with Apple**. Leave it as “Enable as a primary App ID.” Do not group it with another app.
5. Save.

## 2. Confirm App Store Connect

1. Open App Store Connect → Apps → CardGrade.
2. Confirm the bundle id on that app is `com.cardgrader.thejudge`.
3. There is no separate Sign in with Apple switch on the app page. The identifier step above is the switch.

## 3. Turn the iMac switches on when you want to try it

The switches are off until this file exists. Create it on the iMac. It is not committed.

`data/beta_flags.json`

```json
{
  "accounts": true,
  "manualEntry": true,
  "firstRunGuide": true,
  "appleAudience": "com.cardgrader.thejudge"
}
```

Restart `npm start` or `npm run start:lan`. Until that file exists, the username login, the one shared inventory, and the current vault stay as they are. The username box is still not an account.

## 4. Sign the app

1. Open the project in Xcode on the Mac that signs CardGrade.
2. Select the CardGrade target → Signing & Capabilities.
3. Confirm **Sign in with Apple** is listed. The team should be the one that owns `8R89NQ33MV`.
4. If Xcode says the capability is not available, the identifier in step 1 was not saved for that team.
5. Archive after step 1. External TestFlight invites stay off until the hosted-server steps in the beta plan.

## What stays on the iMac

Scans with no account are the bench. A signed-in shop sees only that shop’s scans. Deleting an account removes that account’s images, grades, and correction examples. It does not remove the bench. Correction examples still do not leave the machine.
