#!/usr/bin/env bash
set -euo pipefail

# ================================================================
# Build & install FFmpeg 7.1.2 from the official release tarball
# with system x264/x265 (Ubuntu 22.04+)
# ================================================================

FFMPEG_VERSION="7.1.2"
FFMPEG_ARCHIVE="ffmpeg-${FFMPEG_VERSION}.tar.xz"
FFMPEG_URL="https://www.ffmpeg.org/releases/${FFMPEG_ARCHIVE}"
FFMPEG_SRC_DIR="$HOME/ffmpeg-${FFMPEG_VERSION}"
INSTALL_PREFIX="/usr/local"

echo "[STEP] Removing any existing ffmpeg installations..."
sudo update-alternatives --remove ffmpeg "$INSTALL_PREFIX/bin/ffmpeg" 2>/dev/null || true
sudo update-alternatives --remove ffprobe "$INSTALL_PREFIX/bin/ffprobe" 2>/dev/null || true
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
echo "[STEP] Preparing source directory..."
cd ~
rm -rf "$FFMPEG_SRC_DIR" "$FFMPEG_ARCHIVE"

echo "[STEP] Downloading FFmpeg ${FFMPEG_VERSION} release tarball..."
curl -L -o "$FFMPEG_ARCHIVE" "$FFMPEG_URL"
tar -xf "$FFMPEG_ARCHIVE"
cd "$FFMPEG_SRC_DIR"

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
echo "[STEP] Registering alternatives..."
sudo update-alternatives --install /usr/bin/ffmpeg ffmpeg "$INSTALL_PREFIX/bin/ffmpeg" 100
sudo update-alternatives --install /usr/bin/ffprobe ffprobe "$INSTALL_PREFIX/bin/ffprobe" 100

echo "[STEP] Cleaning up source directories..."
cd ~
rm -rf "$FFMPEG_SRC_DIR" "$FFMPEG_ARCHIVE"

echo "[DONE] FFmpeg + ffprobe installation complete!"
echo
echo "Installed versions:"
ffmpeg -version | head -n 1
ffprobe -version | head -n 1
