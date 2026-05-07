FROM apify/actor-node-playwright-firefox:20
COPY . ./
RUN npm install --quiet --only=prod --no-optional
CMD npm start
