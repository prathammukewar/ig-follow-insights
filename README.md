# Follow Insights for Instagram

A Chrome extension that shows you who doesn't follow you back, who unfollowed you, who is new, and lets you tidy up who you follow. Everything runs in your browser using the Instagram session you are already logged in to. Nothing is sent anywhere else.

## Install (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder (`ig-follow-insights`).
4. Pin the extension from the puzzle icon in the toolbar if you want quick access.

The dashboard opens on its own after install. You can always get back to it from the popup or by right clicking the icon and choosing Options.

## First scan

1. Log in to instagram.com in Chrome.
2. Click the extension icon, then **Scan now**. If no Instagram tab is open, one opens in the background.
3. Wait for the scan to finish. A few hundred accounts take well under a minute. Ten thousand takes a few minutes because the scan pauses between requests on purpose.

While a scan runs, a panel at the top of the dashboard shows which step it is on, how many accounts have come back, how many requests have gone to Instagram, the pace, the time elapsed, an estimate of the time remaining, and any pauses Instagram forced. The popup shows the short version.

Scan again whenever you like. Every scan is compared with the previous one, so from the second scan onward you get a running log of who followed and unfollowed you.

## What you get

- **Overview**: follower and following counts with changes since the last scan, ratio, and a trend chart.
- **Not following back**: people you follow who don't follow you. Sort by how recently you followed them.
- **Fans**: people who follow you that you don't follow back.
- **Mutual, Followers, Following**: full lists with search, sort and filters for verified and private accounts.
- **Changes**: new followers, people who unfollowed you, and changes to who you follow. Compare any two scans. Below that, an activity log of everything ever recorded.
- **History**: a table of every scan with deltas, plus export and delete per scan.
- **Whitelist** for accounts you want to keep regardless. They're hidden from Not following back and skipped by bulk unfollows. Start typing a username or name and pick from the suggestions, or use the star on any row.
- **Suggested whitelist**: the Whitelist page ranks the accounts you follow that don't follow back by how many followers they have, since popular accounts rarely follow back. Click Load counts once, set a minimum follower count, then add them one at a time or all at once.
- **Bios and follower counts**: click **Load bios** on any list to fetch the bio, website, category, and follower, following and post counts for the rows on screen, or click **Bio** on a single row. Once loaded, search also matches bio text (try a school name), and you can sort by most or fewest followers.
- **Follow and unfollow** from any row, one at a time or in a batch with a long pause between actions.
- **Export** any list as CSV or JSON, or copy the usernames.
- **Profile pill** on instagram.com: open any profile and a small note at the bottom right tells you whether they follow you, based on the last scan.
- **Automatic scans** on a schedule, with a notification when they finish (off by default, see Settings).
- **Backup and restore** of all data as a JSON file.
- **Multiple accounts**: log in to a different Instagram account and scan. Each keeps its own history.

## Staying out of trouble with Instagram

The scan uses the same requests Instagram's own website makes when you open your followers list, spaced out with random pauses. That has been fine in practice, but Instagram does rate limit. If you see "Instagram is rate limiting requests" the scan waits and retries on its own. If it gives up, wait 15 to 30 minutes.

Loading bios means one request per profile, so it runs one at a time with a pause between them (1.5 seconds by default, adjustable in Settings). A hundred profiles take about three minutes. Bios are cached, so you only pay that once per person.

Following and unfollowing is a different matter. Instagram blocks accounts that do too many of these in a short time, sometimes for a day or more. The defaults (one action every 12 seconds, at most 25 per batch) are conservative. Keep it that way, especially on a newer account. A batch stops the moment Instagram pushes back.

Automated actions may be against Instagram's terms. Use the follow and unfollow features sparingly and at your own risk.

## Troubleshooting

- **"You are not logged in"**: log in on instagram.com in this Chrome profile and scan again.
- **"Instagram wants you to log in again"**: open the Instagram tab, complete whatever Instagram asks, then rescan.
- **Scan seems stuck**: the Instagram tab was probably closed or put to sleep. Click Reset in the sidebar and scan again. Keeping the Instagram tab open (it can be in the background) is enough.
- **Avatars show initials**: profile picture links from Instagram expire after a while. They refresh on the next scan.
- **Counts differ from Instagram**: the dashboard shows how many accounts Instagram actually listed, and the Overview shows Instagram's own counter next to it when they differ. The gap is almost always deactivated, disabled or restricted accounts, which Instagram still counts but leaves out of every list (including its own). When a list comes back short, the scan fetches it a second time in a different order and merges anything the first pass skipped. You can turn that off in Settings.

## Privacy

The extension talks only to instagram.com and Instagram's image CDN. All data lives in Chrome's extension storage on this computer. Delete it any time from Settings.

## Files

- `manifest.json`: extension config (Manifest V3).
- `background.js`: opens the Instagram tab, kicks off scans, saves results, schedules automatic scans.
- `content.js`: runs on instagram.com; fetches the lists and shows the profile pill.
- `dashboard.*`: the full page dashboard.
- `popup.*`: the toolbar popup.
- `lib/store.js`: storage layout and the logic that turns two scans into a list of changes.
