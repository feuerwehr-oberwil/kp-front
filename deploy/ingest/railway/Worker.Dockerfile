# The celery worker. Same image as `web`, different entrypoint — GlitchTip needs a worker to
# turn an ingested envelope into an issue, so without this events arrive and nothing happens.
# Deployed from a Dockerfile rather than the bare image because Railway's CLI cannot set a
# custom start command on an image-only service.
FROM glitchtip/glitchtip:v4.1.5
CMD ["./bin/run-celery-with-beat.sh"]
