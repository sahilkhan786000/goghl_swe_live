# Before the assessment (10 minutes)

`SESSION_OVERVIEW.pdf` (same content as `SESSION_OVERVIEW.html`) explains how
the day runs, the rules and how you are assessed. Read it first.

Do this at least a day before, on the machine and network you will use.

1. Install **Node 22**, **git** and **Docker Desktop**. Start Docker.
2. Pull the images, so nothing has to download during the session:

   ```
   docker pull mongo:7
   docker pull redis:7-alpine
   docker pull node:22-alpine
   docker pull docker.elastic.co/elasticsearch/elasticsearch:8.15.3   # optional, 1.2 GB
   ```

3. Run the check:

   ```
   node doctor.js --preflight
   ```

   Every line should say PASS. WARN lines tell you what to do.

4. Set up your **AI coding tool** and find out how to export a conversation
   from it as a file. You will be asked to hand the exports in.
If Docker will not run on your machine, tell us before the day. There are two
fallbacks: GitHub Codespaces, or running the simulators with plain Node and
using a MongoDB and Redis you already have.

5. Make sure you have **your own GitHub account** and that `git push` works
   from your terminal. On the day you create a new repository there: private
   while you work, public when you submit. Do not create it in advance.

On the day you build one small product in two hours, in your own repository.
AI tools are allowed and expected. A program checks your work automatically,
and you get the same program to run yourself. You submit a form with your
repository address and the id of your final commit before the two hours are
up. Shortlisted candidates explain and debug their own code in a follow-up
call.
