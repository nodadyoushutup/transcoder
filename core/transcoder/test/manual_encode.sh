# Do not modify this file
ffmpeg -re -copyts -start_at_zero -fflags +genpts \
  -i /media/tmp/wicked.mkv \
  -map 0:v -c:v libx264 -preset ultrafast -b:v 5M -maxrate 5M -bufsize 10M \
  -g 48 -keyint_min 48 -sc_threshold 0 -vsync 1 \
  -map 0:a:0 -c:a aac -profile:a aac_low -ar 48000 -ac 2 -b:a 192k \
  -af aresample=async=1:first_pts=0 \
  -f dash \
  -streaming 1 \
  -seg_duration 2 -frag_duration 2 -min_seg_duration 2000000 \
  -use_template 1 -use_timeline 1 \
  -window_size 12 -extra_window_size 6 \
  -muxpreload 0 -muxdelay 0 \
  -remove_at_exit 1 \
  -init_seg_name 'init-$RepresentationID$.m4s' \
  -media_seg_name 'chunk-$RepresentationID$-$Number%05d$.m4s' \
  -adaptation_sets "id=0,streams=v id=1,streams=a" \
  "$HOME/ingest_data/audio_video.mpd"
