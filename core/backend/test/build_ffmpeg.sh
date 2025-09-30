#!/usr/bin/env bash
set -euo pipefail

# ================================================================
# Build & install FFmpeg 8.0 from the official release tarball
# with system x264/x265 (Ubuntu 22.04+)
# ================================================================

FFMPEG_SRC_DIR="$HOME/ffmpeg-8.0"
INSTALL_PREFIX="/usr/local"

echo "[STEP] Removing any old ffmpeg packages..."
sudo apt -y remove --purge ffmpeg || true
sudo apt -y autoremove || true

echo "[STEP] Installing build dependencies..."
sudo apt update
sudo apt -y install \
  autoconf automake build-essential cmake git libass-dev libfreetype6-dev \
  libgnutls28-dev libsdl2-dev libtool libva-dev libvdpau-dev libvorbis-dev \
  libxcb1-dev libxcb-shm0-dev libxcb-xfixes0-dev meson ninja-build pkg-config \
  texinfo wget yasm nasm zlib1g-dev libunistring-dev libaom-dev libdav1d-dev \
  libmp3lame-dev libopus-dev libvpx-dev curl xz-utils \
  libx264-dev libx265-dev

# ------------------------------------------------
# Build FFmpeg (release tarball)
# ------------------------------------------------
echo "[STEP] Downloading FFmpeg 8.0 release tarball..."
cd ~
rm -rf "$FFMPEG_SRC_DIR"
curl -LO https://ffmpeg.org/releases/ffmpeg-8.0.tar.xz
tar -xf ffmpeg-8.0.tar.xz
cd ffmpeg-8.0

PKG_CONFIG_PATH="$INSTALL_PREFIX/lib/pkgconfig" \
./configure \
  --prefix="$INSTALL_PREFIX" \
  --enable-gpl \
  --enable-libaom \
  --enable-libass \
  --enable-libfreetype \
  --enable-libmp3lame \
  --enable-libopus \
  --enable-libvorbis \
  --enable-libvpx \
  --enable-libdav1d \
  --enable-libx264 \
  --enable-libx265 \
  --enable-nonfree

make -j"$(nproc)"
sudo make install

# ------------------------------------------------
# Alternatives + cleanup
# ------------------------------------------------
echo "[STEP] Updating alternatives..."
sudo update-alternatives --install /usr/bin/ffmpeg ffmpeg "$INSTALL_PREFIX/bin/ffmpeg" 100
sudo update-alternatives --install /usr/bin/ffprobe ffprobe "$INSTALL_PREFIX/bin/ffprobe" 100

echo "[STEP] Cleaning up source directories..."
cd ~
rm -rf "$FFMPEG_SRC_DIR" ffmpeg-8.0.tar.xz

echo "[DONE] FFmpeg + ffprobe installation complete!"
echo
echo "Installed versions:"
ffmpeg -version | head -n 1
ffprobe -version | head -n 1
