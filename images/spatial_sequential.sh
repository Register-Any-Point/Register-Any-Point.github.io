#!/bin/bash

set -e  # Exit on error

# Input files (can be either GIF or WebM)
FILE1="first.webm"
FILE2="second.webm"

# Function to check if a command succeeded
check_success() {
    if [ $? -ne 0 ]; then
        echo "Error: $1 failed"
        exit 1
    fi
}

# Get the dimensions of input files
get_dimensions() {
    ffprobe -v error -select_streams v:0 \
        -show_entries stream=width,height \
        -of csv=p=0 "$1"
}

# Get duration of first file more robustly
get_duration() {
    # Try to get duration from container
    duration=$(ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "$1")
    
    # If duration is N/A or empty, try to get it from stream
    if [ "$duration" = "N/A" ] || [ -z "$duration" ]; then
        duration=$(ffprobe -v error -select_streams v:0 -show_entries stream=duration -of default=noprint_wrappers=1:nokey=1 "$1")
    fi
    
    # If still N/A or empty, count frames and divide by framerate
    if [ "$duration" = "N/A" ] || [ -z "$duration" ]; then
        frames=$(ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=nb_read_frames -of default=noprint_wrappers=1:nokey=1 "$1")
        fps=$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of default=noprint_wrappers=1:nokey=1 "$1")
        # Calculate fps from fraction if needed
        if [[ $fps == *"/"* ]]; then
            num=${fps%/*}
            den=${fps#*/}
            fps=$(echo "scale=2; $num / $den" | bc)
        fi
        duration=$(echo "scale=2; $frames / $fps" | bc)
    fi
    
    echo "$duration"
}

# Check if input files exist
if [ ! -f "$FILE1" ] || [ ! -f "$FILE2" ]; then
    echo "Error: Input files not found"
    exit 1
fi

# Read dimensions
IFS=, read -r WIDTH1 HEIGHT1 <<< $(get_dimensions "$FILE1")
check_success "Getting dimensions of first file"
IFS=, read -r WIDTH2 HEIGHT2 <<< $(get_dimensions "$FILE2")
check_success "Getting dimensions of second file"
DURATION1=$(get_duration "$FILE1")
check_success "Getting duration of first file"

if [ -z "$DURATION1" ] || [ "$DURATION1" = "N/A" ]; then
    echo "Error: Could not determine duration of first file"
    exit 1
fi

echo "First file: ${WIDTH1}x${HEIGHT1}, Duration: $DURATION1 seconds"
echo "Second file: ${WIDTH2}x${HEIGHT2}"

# Calculate the total width needed
TOTAL_WIDTH=$((WIDTH1 + WIDTH2))
MAX_HEIGHT=$((HEIGHT1 > HEIGHT2 ? HEIGHT1 : HEIGHT2))

echo "Step 1: Creating static frame from second animation..."
ffmpeg -y -i "$FILE2" -vframes 1 static_frame.png
check_success "Creating static frame"

echo "Step 2: Creating static video for the duration of first animation..."
ffmpeg -y -loop 1 -i static_frame.png \
    -t "$DURATION1" \
    -c:v libx264 -pix_fmt yuv420p \
    -r 30 \
    static_part.mp4
check_success "Creating static video"

echo "Step 3: Creating delayed second animation..."
ffmpeg -y -i static_part.mp4 -i "$FILE2" \
    -filter_complex "[0:v][1:v]concat=n=2:v=1:a=0[v]" -map "[v]" \
    delayed_second.mp4
check_success "Creating delayed animation"

echo "Step 4: Combining videos side by side..."
ffmpeg -y -i "$FILE1" -i delayed_second.mp4 \
    -filter_complex "[0:v][1:v]hstack=inputs=2[v]" -map "[v]" \
    -c:v libvpx-vp9 \
    -deadline good \
    -cpu-used 2 \
    output.webm
check_success "Creating final output"

# Clean up temporary files
if [ -f "static_frame.png" ]; then rm static_frame.png; fi
if [ -f "static_part.mp4" ]; then rm static_part.mp4; fi
if [ -f "delayed_second.mp4" ]; then rm delayed_second.mp4; fi

echo "Successfully created output.webm with sequential playback"
echo "Output dimensions: ${TOTAL_WIDTH}x${MAX_HEIGHT}"

# Display information about the output file
if [ -f "output.webm" ]; then
    ffprobe -v error -select_streams v:0 \
        -show_entries stream=width,height,duration \
        -of default=noprint_wrappers=1 output.webm
else
    echo "Error: Output file was not created"
    exit 1
fi
