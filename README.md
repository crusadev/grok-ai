If you re reading this, please dont :D its the first commit and im still writing the ideas so you could be finding nonsense or unfinished ideas.

## What is the biggest challenge for this project?
Before being able to actually start the project i had a good amount of days to think ( and i love thinking ), the main question that repeated in my head all the time was "What does a good anti-bot system check for in a browser?", it ranges from all sort of things, from hardware to mouse movements to browser profiles and many more. I was planning on how to 'humanize' the browser when i stumbled upon CloakBrowser that just came in clutch.

**CloakBrowser is a chromium instance with fingerprints modified at the c++ source level, and the best part, its open source**

After some tests i confirmed that this browser is pretty undetectable by grok, its really easy to use with playwright/puppeteer, it has a self hosted browser profile manager interface etc etc, its a really complete solution.

## The network solution
To manage the per country request, avoid rate limiting, retrying on paywall and more reasons, i decided to use proxies, obviously residential proxies to look like a legitimate user, for this i picked decodo since i found it the best suited for our scenario and did not have much time to search more in depth
The approach is simple, for each request we rotate the proxy within the same country, from what ive seen if you try again enough times within the same country you will get the answer at some point ( normally between 2-6 times )

## The scalability approach
To make this scalable is not really hard, we will use K8 clusters, where each pod will be able to run 4-5 browser instances at the same time. We can use redis/bullmq for the queue, we put some custom limits on how kubernetes scales horizontally so it downgrades/upgrades based on number of requests.

## The retry functionality
Through the selector we observe when the paywall appears and we instantly close the browser and try again.
Currently im using the humanize parameter, from what ive seen it takes too long to write the prompt

## Side notes
For now the country with the least paywall scenarios is Canada
