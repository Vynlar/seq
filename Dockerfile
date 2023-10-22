# Use an official Node.js runtime as the base image
FROM node:16-alpine

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first
# This layer will be cached if these files don't change
COPY package*.json ./

# Install project dependencies
RUN npm install

# Copy the rest of the application
COPY . .

# If you want to build the TypeScript source to JavaScript here, do so
RUN npm run build

# The command to run your application
CMD [ "node", "dist/index.js" ]
