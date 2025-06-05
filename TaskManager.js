import React, { useState, useEffect } from 'react';
import './TaskManager.css';

const TaskManager = ({ 
  tasks = [], 
  onCreateTask, 
  onUpdateTask, 
  onDeleteTask,
  parentId = null,
  parentType = null
}) => {
  const [newTaskText, setNewTaskText] = useState('');
  const [newTaskDueDate, setNewTaskDueDate] = useState('');
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [editText, setEditText] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  
  // Format date for input field
  const formatDateForInput = (dateString) => {
    if (!dateString) return '';
    const date = new Date(dateString);
    return date.toISOString().split('T')[0];
  };
  
  // Format date for display
  const formatDateForDisplay = (dateString) => {
    if (!dateString) return 'No due date';
    const date = new Date(dateString);
    return date.toLocaleDateString();
  };
  
  // Handle task creation
  const handleCreateTask = (e) => {
    e.preventDefault();
    if (!newTaskText.trim()) return;
    
    const newTask = {
      text: newTaskText.trim(),
      due_date: newTaskDueDate || null,
      completed: false,
      parent_id: parentId,
      parent_type: parentType
    };
    
    onCreateTask(newTask);
    setNewTaskText('');
    setNewTaskDueDate('');
  };
  
  // Handle task completion toggle
  const handleToggleComplete = (taskId, completed) => {
    onUpdateTask(taskId, { completed: !completed });
  };
  
  // Start editing a task
  const handleStartEdit = (task) => {
    setEditingTaskId(task.id);
    setEditText(task.text);
    setEditDueDate(formatDateForInput(task.due_date));
  };
  
  // Cancel editing
  const handleCancelEdit = () => {
    setEditingTaskId(null);
    setEditText('');
    setEditDueDate('');
  };
  
  // Save edited task
  const handleSaveEdit = (taskId) => {
    if (!editText.trim()) return;
    
    onUpdateTask(taskId, {
      text: editText.trim(),
      due_date: editDueDate || null
    });
    
    setEditingTaskId(null);
    setEditText('');
    setEditDueDate('');
  };
  
  // Delete a task
  const handleDeleteTask = (taskId) => {
    if (window.confirm('Are you sure you want to delete this task?')) {
      onDeleteTask(taskId);
    }
  };
  
  // Determine if a task is overdue
  const isOverdue = (dueDate) => {
    if (!dueDate) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const taskDueDate = new Date(dueDate);
    return taskDueDate < today;
  };
  
  return (
    <div className="task-manager">
      <h3>Tasks</h3>
      
      {/* Task creation form */}
      <form onSubmit={handleCreateTask} className="task-form">
        <input
          type="text"
          value={newTaskText}
          onChange={(e) => setNewTaskText(e.target.value)}
          placeholder="Add a new task..."
          className="task-input"
        />
        <input
          type="date"
          value={newTaskDueDate}
          onChange={(e) => setNewTaskDueDate(e.target.value)}
          className="date-input"
        />
        <button type="submit" className="add-task-button">Add</button>
      </form>
      
      {/* Tasks list */}
      <ul className="tasks-list">
        {tasks.map(task => (
          <li 
            key={task.id} 
            className={`task-item ${task.completed ? 'completed' : ''} ${isOverdue(task.due_date) && !task.completed ? 'overdue' : ''}`}
          >
            {editingTaskId === task.id ? (
              <div className="task-edit-form">
                <input
                  type="text"
                  value={editText}
                  onChange={(e) => setEditText(e.target.value)}
                  className="task-input"
                  autoFocus
                />
                <input
                  type="date"
                  value={editDueDate}
                  onChange={(e) => setEditDueDate(e.target.value)}
                  className="date-input"
                />
                <div className="task-edit-actions">
                  <button onClick={() => handleSaveEdit(task.id)} className="save-button">Save</button>
                  <button onClick={handleCancelEdit} className="cancel-button">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                <div className="task-checkbox-container">
                  <input
                    type="checkbox"
                    checked={task.completed}
                    onChange={() => handleToggleComplete(task.id, task.completed)}
                    id={`task-${task.id}`}
                    className="task-checkbox"
                  />
                  <label 
                    htmlFor={`task-${task.id}`}
                    className="task-checkbox-label"
                  ></label>
                </div>
                <div className="task-content">
                  <div className="task-text">{task.text}</div>
                  <div className="task-due-date">
                    {task.due_date && (
                      <span className={isOverdue(task.due_date) && !task.completed ? 'overdue-text' : ''}>
                        Due: {formatDateForDisplay(task.due_date)}
                      </span>
                    )}
                  </div>
                </div>
                <div className="task-actions">
                  <button onClick={() => handleStartEdit(task)} className="edit-button">Edit</button>
                  <button onClick={() => handleDeleteTask(task.id)} className="delete-button">Delete</button>
                </div>
              </>
            )}
          </li>
        ))}
        
        {tasks.length === 0 && (
          <li className="no-tasks">No tasks yet. Add one above!</li>
        )}
      </ul>
    </div>
  );
};

export default TaskManager;
