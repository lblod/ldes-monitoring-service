FROM semtech/mu-javascript-template:1.9.1
LABEL maintainer="info@redpencil"
ENV SUDO_QUERY_RETRY="true"
ENV SUDO_QUERY_RETRY_FOR_HTTP_STATUS_CODES="404,500,503"