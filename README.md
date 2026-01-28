### txt
> "anti-social for a reason"   

![status](https://img.shields.io/badge/status-active-success)
![license](https://img.shields.io/badge/license-MIT-blue)
![github stars](https://img.shields.io/github/stars/auth1ery/txt?style=social)
![github forks](https://img.shields.io/github/forks/auth1ery/txt?style=social)
![made with love](https://img.shields.io/badge/made%20with-♥-red)

txt is a simple and lightweight social media designed for anyone and any browser
its very small in size of the source code and the backend is built to use as little CPU and RAM as possible

# features

- posting
- score system (upvoting and downvoting)
- comments and replies
- profiles
- customizable profile pages
- reporting system
- inboxes
- email system
- html, css, and js sanitization

# install

before you install dependencies, you need to delete .github/workflows/discord.yml. its not required and is only for this repo ONLY.

after that, run:

```npm install```

this alone will install:
- pg (PostgreSQL client for Node.js)
- express (web framework)
from package.json.

cant install from that command? then you'll need to manually install node.js and postgreSQL from these websites:
https://nodejs.org
https://postgresql.org

after that, set up these environment variables:

ADMIN_PASS is for the password to enter admin.html.   
DATABASE_URL is your PostgreSQL database URL.   
DISCORD_WEBHOOK is optional, but great if you want to see new posts made in real time in a Discord server.   

if you would NOT like discord intergration, just make the environmental variable but leave it blank

once things are fully in and installed, start the server:

```npm start```

or use the dockerfile

thats it!
