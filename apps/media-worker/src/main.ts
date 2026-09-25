const queueName = process.env.MEDIA_WORKER_QUEUE ?? "lyonix.media";
console.info(`LyOnix media worker ready on ${queueName}; FFmpeg runs here only`);
