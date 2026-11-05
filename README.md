# Brightwork Office (demo)

A working demo of Koret's virtual office, for presenting to prospects: who is in, doors and knocks,
three daily reports, tasks with stars, a weekly leaderboard, email alerts. Plus five things the live
office does not have yet: Insights, Notices, Time off, Rooms (with private room conversations and invites by email) and Team chat.

Everything is real except the network. The real screens and SQL run on Postgres inside your browser,
with a fictional company and a simulated team. No account, no keys, no data leaves the page.

```bash
npm install
npm run db     # builds the database snapshot
npm run dev
```

`npm run build` does all of it for production. See [PRESENTING.md](PRESENTING.md) to run a demo and
[CLAUDE.md](CLAUDE.md) for how it is built.
