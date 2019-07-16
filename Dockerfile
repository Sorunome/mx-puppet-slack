FROM node:alpine

COPY . /opt/mx-puppet-slack
WORKDIR /opt/mx-puppet-slack
RUN apk add --no-cache ca-certificates \
	&& apk add --no-cache --virtual .build-deps git make gcc g++ python \
	&& npm install \
	&& npm run build \
	&& apk del .build-deps
VOLUME ["/data"]
ENTRYPOINT ["./docker-run.sh"]
