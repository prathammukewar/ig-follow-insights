# Follow Insights

The first time I ran this against my own account, Instagram's profile page said I followed 1,665 people and the list it served me stopped at 1,590. The missing 75 are deactivated, disabled and restricted accounts. Instagram still counts them against you, it just won't show them to you, and it won't show them to itself either: scroll your own following list in the app and you'll run out of names before you hit the number printed at the top of the page.

So that's the first thing this extension does. It reads your followers and following lists through the Instagram tab you're already signed in to, keeps a copy in the browser, and diffs each scan against the last one, which is the only way to know who left and roughly when. There's no server. There's nowhere for the data to go.

## Getting it running

Chrome, `chrome://extensions`, Developer mode on, Load unpacked, pick this folder. Pin it if you want the popup one click away. The dashboard opens by itself the first time and lives behind the extension icon after that.

Then log in to instagram.com, hit Scan now, and leave the tab open while it works. It can sit in the background. From the second scan onward you get the interesting half: who followed you since last time, who unfollowed, and whether the ones who vanished actually unfollowed or just deactivated.

## The parts worth knowing about

**Not following back** is the list everyone comes for, and on its own it's a bad list, because it puts your friend who forgot and Barack Obama in the same column. So the Whitelist page ranks those accounts by how many followers *they* have and offers to whitelist the top of that list in one click. Whitelisted people disappear from Not following back and bulk unfollows skip them.

**The waiting room** is the same idea across time: people you followed more than two weeks ago who still haven't followed back. Instagram's lists don't carry dates, so out of the box this only knows what it's watched happen. Feed it the "Download your information" zip in Settings and every date becomes exact, going back years.

**Bios** get loaded one profile at a time in the background after a scan, worst offenders first. Once they're in, search matches bio text, so typing your school name finds everyone from it, and you can turn that search into a saved group with a preview of who's about to get tagged. Groups also take notes, which is the only way I can remember who half my followers are.

The rest is less interesting but it's there: mutual friends with any account, follow requests in both directions, CSV and JSON export, scheduled scans, multiple accounts, a pill on every Instagram profile telling you where you stand with that person, and backup to a file.

## What actually broke

The scan is the same request instagram.com makes when you open your own followers list, so I assumed it would be boring. It wasn't.

My first version fired about five requests a second because that seemed fast and nothing complained for the first thirty seconds. Then Instagram throttled the whole session, which I could live with, except throttling also breaks unfollows, so I spent a while convinced I'd broken the unfollow button. I hadn't. I'd just been rude.

Worse: at some point Instagram stopped answering `/api/v1/friendships/<id>/followers/` for my account and started returning the login page with a `200 OK`. Following worked fine. Only followers broke, only for that session, and nothing in the response said why. Reading it back out of the extension's own LevelDB on disk was how I finally saw it. So the request now goes down a ladder:

```
followers, in the order it tries
  fetchList      50 per page with search_surface   <- what the site itself sends
                 50 per page without it
                 25 per page, both ways
                 all four again against i.instagram.com
  fetchOffsets   once any of those answers, pull three pages at a time
  fetchLearned   if every one is refused: replay whatever observer.js watched
                 instagram.com send for its own list, cursor handling and all
```

That last one is the part I'm actually pleased with. `observer.js` sits in the page and notes the shape of the requests the site makes, so when Instagram changes its endpoint or blocks mine, the extension copies the site's homework instead of me guessing at a new URL. It handles the GraphQL version too, which is where Instagram seems to be moving.

It still doesn't always work. If Instagram has decided your session doesn't get the followers list today, no extension can talk it out of that, and the honest answer is to wait. Settings has a Diagnostics button that tries every shape once and shows you exactly what came back, including the page title of whatever HTML it got, so at least you can tell "Instagram is annoyed" from "this thing is broken."

## Not getting your account limited

Scanning is cheap and Instagram mostly tolerates it. The scan paces itself, speeds up while things are going well, and backs off the moment it sees a rate limit. Gentle, Normal and Fast presets are in Settings if you'd rather decide yourself.

Following and unfollowing is a different animal. Instagram will block those actions on your account for a day if you do too many too fast, and that's true whether you use this or tap the buttons yourself. The defaults here are one action every twelve seconds, twenty five per batch, and sixty per rolling day, and the extension refuses to go past that last one. New accounts should be well under it. A batch stops the instant Instagram pushes back.

Automating any of this is arguably against Instagram's terms. Unfollow sparingly, and know that it's your account on the line.

## When something's wrong

- **A list stuck at 0 while the other one fills up.** That's the login-page-with-a-200 problem above. Open that list on instagram.com, scroll it a bit so `observer.js` can watch, come back and rescan.
- **"Please wait a few minutes" on an unfollow.** Rate limiting, usually because the bio loader was running. It clears on its own, and the dashboard shows when.
- **"feedback_required" on an unfollow.** Different thing: an action block on the account itself. Wait a day, and don't unfollow forty people the moment it lifts.
- **The scan stops reporting progress.** The Instagram tab got closed or slept. Reset in the sidebar, scan again.
- **Initials instead of profile pictures.** Instagram's image links expire. The next scan refreshes them.
- **Counts that don't match Instagram's.** See the top of this file. The Overview shows both numbers side by side when they disagree.

## Privacy

Two origins get talked to: instagram.com and Instagram's image CDN. Everything else stays in Chrome's extension storage on your own machine, and Settings has a button that deletes all of it.

## The code

`content.js` does the fetching and draws the profile pill. `observer.js` is the page-world script described above, and it records URLs, methods and Instagram's own request headers, never cookies and never response bodies. `background.js` owns the Instagram tab and the schedule. `lib/store.js` holds the storage layout and the diff that turns two scans into "these four people left." `dashboard.*` and `popup.*` are the UI.
