FROM apify/actor-node-playwright-chrome:20
COPY . ./
RUN npm install --quiet --only=prod --no-optional
CMD npm start
