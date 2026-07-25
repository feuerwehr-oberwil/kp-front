# GlitchTip web, with migrations applied on boot.
#
# The upstream compose file runs migrations as a separate one-shot service. Railway has no
# equivalent, and the failure mode of forgetting is quiet and nasty: the container comes up,
# uWSGI serves, and every request dies on a missing table — which is exactly what happened
# during setup. Running `migrate` in front of the normal start script makes an upgrade
# self-applying instead of a thing someone has to remember at the wrong moment.
FROM glitchtip/glitchtip:v4.1.5
CMD ["sh", "-c", "python manage.py migrate --noinput && ./bin/start.sh"]
