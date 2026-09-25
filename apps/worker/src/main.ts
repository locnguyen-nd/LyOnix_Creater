const queueName = process.env.WORKER_QUEUE ?? "lyonix.workflow";
console.info(`LyOnix workflow worker ready on ${queueName}`);
