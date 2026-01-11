### txt
> "some like social media thing"   

![status](https://img.shields.io/badge/status-active-success)
![license](https://img.shields.io/badge/license-MIT-blue)
![github stars](https://img.shields.io/github/stars/auth1ery/txt?style=social)
![github forks](https://img.shields.io/github/forks/auth1ery/txt?style=social)
![made with love](https://img.shields.io/badge/made%20with-♥-red)

txt is a simple and lightweight social media designed for anyone and any browser

its very small in size of the source code, often just some kilobytes. the frontend and backend is built to use as little CPU, and RAM and possible as well as save bandwidth. 

# features

- posting
- score system (upvoting and downvoting)
- comments and replies
- profiles
- reporting system

# install

you typlically need to just run:

```npm install```

this alone will install:
- pg (PostgreSQL client for Node.js)
- express (web framework)
from package.json.

cant install from that command? then you'll need to manually install node.js and postgreSQL from these websites:
https://nodejs.org
https://postgresql.org

after when you install the requirements, you can just run:

```npm start```

HOWEVER if you want to have the full features of txt:

make 3 environmentable variables, and name each one of them:
- ADMIN_PASS
- DATABASE_URL
- DISCORD_WEBHOOK

ADMIN_PASS is for the password to enter admin.html.   
DATABASE_URL is your PostgreSQL database URL.   
DISCORD_WEBHOOK is optional, but great if you want to see new posts made in real time in a Discord server.   

thats it!

<br>
<br>
<p align="center">
   ⚡
</p>
