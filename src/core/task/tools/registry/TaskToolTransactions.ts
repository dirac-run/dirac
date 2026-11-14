import Mutex from "p-mutex";

const transactions = new Map<string, { mutex: Mutex; users: number }>()

/** Acquire before mutation authorization; waiting with a mutation lease would block configuration transitions. */
export async function withTaskToolTransaction<T>(rootTaskId: string, operation: () => Promise<T>): Promise<T> {
	const transaction = transactions.get(rootTaskId) ?? { mutex: new Mutex(), users: 0 }
	transactions.set(rootTaskId, transaction)
	transaction.users += 1
	try {
		return await transaction.mutex.withLock(operation)
	} finally {
		transaction.users -= 1
		if (transaction.users === 0) transactions.delete(rootTaskId)
	}
}
